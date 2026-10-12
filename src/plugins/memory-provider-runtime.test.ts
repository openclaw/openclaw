/** Tests selected-owner fallback, caller revocation, and legacy compatibility at the resolver. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { delegateMemoryAudience, resolveMemoryAudienceFromEntry } from "./memory-audience.js";
import { fakeSessionOwner } from "./memory-audience.test-support.js";
import type { MemoryCallerContext, MemoryProviderHandle } from "./memory-provider-types.js";
import type {
  MemoryPluginCapability,
  MemoryProviderRuntime,
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const state = vi.hoisted(() => ({ capability: {} as MemoryPluginCapability }));
vi.mock("../agents/agent-scope.js", () => ({ resolveAgentWorkspaceDir: vi.fn() }));
vi.mock("./loader.js", () => ({ loadPluginRegistryHandle: vi.fn() }));
vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("./memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("./memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});
vi.mock("./memory-state.js", () => ({
  getMemoryRuntime: () => state.capability.runtime,
  getMemoryProviderRuntime: () => state.capability.providerRuntime,
  getMemoryCapabilityRegistration: () => ({
    pluginId: "test-memory",
    capability: state.capability,
  }),
  resolveMemoryCapabilityRegistration: (registrations: unknown[]) => registrations[0],
  setStandaloneMemoryManagerActive: vi.fn(),
}));
import {
  closeActiveMemorySearchManagersCore,
  getActiveMemoryProviderCore,
  prepareMemoryRuntimeReload,
} from "./memory-runtime.js";

function context() {
  let current = true;
  return {
    revoke() {
      current = false;
    },
    value: {
      authority: { kind: "session", sessionKey: "agent:main:chat", sandboxed: true },
      assertCurrent() {
        if (!current) {
          throw new Error("caller revoked");
        }
      },
    } satisfies MemoryCallerContext,
  };
}
function provider() {
  const capabilities: MemoryProviderHandle["capabilities"] = {
    sources: ["memory"],
    pagination: false,
    candidates: [],
    projectFilter: false,
  };
  return {
    capabilities,
    search: vi.fn<MemoryProviderHandle["search"]>(async () => ({ hits: [] })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  } satisfies MemoryProviderHandle;
}
function open(caller = context()) {
  return getActiveMemoryProviderCore({ cfg: {}, agentId: "main", context: caller.value });
}
function legacy(searchManager: RegisteredMemorySearchManager) {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: searchManager })),
    resolveMemoryBackendConfig: vi.fn<MemoryPluginRuntime["resolveMemoryBackendConfig"]>(() => ({
      backend: "builtin",
    })),
  } satisfies MemoryPluginRuntime;
}
const hit = {
  path: "virtual:record",
  startLine: 2,
  endLine: 3,
  score: 0.8,
  snippet: "remember",
  source: "memory" as const,
};
function manager(): RegisteredMemorySearchManager {
  return {
    search: vi.fn(async () => [hit]),
    readFile: vi.fn(async () => ({
      text: "",
      path: "virtual:record",
      truncated: true,
      from: 4,
      lines: 2,
      nextFrom: 6,
    })),
    status: () => ({ backend: "builtin", provider: "test" }),
    probeEmbeddingAvailability: async () => ({ ok: true }),
    probeVectorAvailability: async () => true,
  };
}

beforeEach(() => {
  state.capability = {};
  fakeSessionOwner.reset();
});

async function ownerAudience(sessionKey: string) {
  const entry = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    lifecycleRevision: "generation-1",
    updatedAt: 1,
    chatType: "direct" as const,
  };
  fakeSessionOwner.rows.set(sessionKey, entry);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: "main",
      sessionKey,
      sessionId: entry.sessionId,
      senderIsOwner: true,
      storePath: "/tmp/openclaw-memory-provider/main.sqlite",
    },
    entry,
  );
  if (resolution.status !== "granted") {
    throw new Error(resolution.reason);
  }
  return { ...resolution, entry };
}
describe("provider-neutral memory resolver", () => {
  it("rejects a minted audience used by a different session", async () => {
    const { audience } = await ownerAudience("agent:main:owner");
    const openProvider = vi.fn(async () => ({ provider: provider() }));
    state.capability.providerRuntime = { open: openProvider };
    const caller = context();
    Reflect.set(caller.value.authority, "audience", audience);
    await expect(open(caller)).rejects.toThrow("memory audience is bound to a different session");
    expect(openProvider).not.toHaveBeenCalled();
    fakeSessionOwner.rows.set(caller.value.authority.sessionKey, {
      sessionId: "recall-session",
      updatedAt: 1,
    });
    const delegate = await delegateMemoryAudience(audience, {
      sessionKey: caller.value.authority.sessionKey,
      storePath: "/tmp/openclaw-memory-provider/main.sqlite",
    });
    Reflect.set(caller.value.authority, "audience", delegate.audience);
    const delegated = await open(caller);
    await expect(delegated.provider!.health()).resolves.toMatchObject({ status: "ready" });
    await delegated.provider!.close();
  });

  it("never opens a provider for an audience that went stale before open", async () => {
    const sessionKey = "agent:main:chat";
    const { audience, entry } = await ownerAudience(sessionKey);
    const openProvider = vi.fn(async () => ({ provider: provider() }));
    state.capability.providerRuntime = { open: openProvider };
    const caller = context();
    Reflect.set(caller.value.authority, "audience", audience);
    fakeSessionOwner.rows.set(sessionKey, { ...entry, lifecycleRevision: "generation-2" });
    await expect(open(caller)).rejects.toThrow("memory audience is no longer current");
    expect(openProvider).not.toHaveBeenCalled();
  });

  it("closes a provider opened while its audience went stale", async () => {
    const sessionKey = "agent:main:chat";
    const { audience, entry } = await ownerAudience(sessionKey);
    const raw = provider();
    state.capability.providerRuntime = {
      open: vi.fn(async () => {
        fakeSessionOwner.rows.set(sessionKey, { ...entry, lifecycleRevision: "generation-2" });
        return { provider: raw };
      }),
    };
    const caller = context();
    Reflect.set(caller.value.authority, "audience", audience);
    await expect(open(caller)).rejects.toThrow("memory audience is no longer current");
    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.health).not.toHaveBeenCalled();
  });

  it("rejects a forged session audience before opening a provider", async () => {
    const openProvider = vi.fn(async () => ({ provider: provider() }));
    state.capability.providerRuntime = { open: openProvider };
    const caller = context();
    Reflect.set(caller.value.authority, "audience", {
      kind: "owner-private",
      agentId: "main",
    });
    await expect(open(caller)).rejects.toThrow("host-minted memory audience");
    expect(openProvider).not.toHaveBeenCalled();
  });

  it("prefers the provider runtime and never falls back after errors or unavailable results", async () => {
    const old = legacy(manager());
    const openProvider = vi
      .fn<MemoryProviderRuntime["open"]>()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce({ provider: null, error: "unavailable" });
    state.capability = { runtime: old, providerRuntime: { open: openProvider } };
    await expect(open()).rejects.toThrow("denied");
    await expect(open()).resolves.toMatchObject({
      provider: null,
      adapter: "native",
      error: "unavailable",
    });
    expect(old.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([null, {}, { unsupported: true }])(
    "rejects malformed advertised provider runtime without legacy fallback: %s",
    async (providerRuntime) => {
      const old = legacy(manager());
      state.capability = { runtime: old };
      // Plugins execute JavaScript; invalid advertisements must not select the old store.
      Reflect.set(state.capability, "providerRuntime", providerRuntime);
      await expect(open()).rejects.toThrow("providerRuntime must implement");
      expect(old.getMemorySearchManager).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-provider refs, revoked results, and retained calls after close", async () => {
    const raw = provider();
    state.capability.providerRuntime = { open: async () => ({ provider: raw }) };
    const caller = context();
    const bound = (await open(caller)).provider!;
    await expect(bound.get({ reference: { providerId: "other", id: "record" } })).rejects.toThrow(
      "different provider",
    );
    expect(raw.get).not.toHaveBeenCalled();
    const deferred = createDeferredCore<{ hits: [] }>();
    vi.mocked(raw.search).mockReturnValueOnce(deferred.promise);
    const searching = bound.search({ query: "test" });
    caller.revoke();
    deferred.resolve({ hits: [] });
    await expect(searching).rejects.toThrow("caller revoked");
    await bound.close();
    await bound.close();
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expect(bound.health()).rejects.toThrow("closed");
  });

  it("releases a lease acquired after caller revocation", async () => {
    const raw = provider();
    const deferred = createDeferredCore<{ provider: MemoryProviderHandle }>();
    state.capability.providerRuntime = { open: () => deferred.promise };
    const caller = context();
    const opening = open(caller);
    caller.revoke();
    deferred.resolve({ provider: raw });
    await expect(opening).rejects.toThrow("caller revoked");
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "missing capabilities",
      (raw: MemoryProviderHandle) => Reflect.deleteProperty(raw, "capabilities"),
    ],
    ["empty sources", (raw: MemoryProviderHandle) => Reflect.set(raw.capabilities, "sources", [])],
    [
      "unknown sources",
      (raw: MemoryProviderHandle) =>
        Reflect.set(raw.capabilities, "sources", ["memory", "unknown"]),
    ],
    [
      "missing candidates function",
      (raw: MemoryProviderHandle) => Reflect.set(raw.capabilities, "candidates", ["trigger"]),
    ],
    [
      "unexpected candidates function",
      (raw: MemoryProviderHandle) => Reflect.set(raw, "candidates", vi.fn()),
    ],
  ])("closes providers with %s", async (_name, invalidate) => {
    const raw = provider();
    invalidate(raw);
    state.capability.providerRuntime = { open: async () => ({ provider: raw }) };
    await expect(open()).rejects.toThrow("valid capabilities with matching candidates");
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["source", { query: "q", sources: ["sessions" as const] }, "sessions source capability"],
    ["pagination", { query: "q", cursor: "next" }, "pagination capability"],
    ["project filter", { query: "q", activeProjectKeys: ["repo"] }, "project filter capability"],
  ])(
    "rejects undeclared search %s before calling the provider",
    async (_name, request, message) => {
      const raw = { ...provider(), candidates: vi.fn(async () => ({ hits: [] })) };
      raw.capabilities = {
        sources: ["memory"],
        pagination: false,
        candidates: ["trigger"],
        projectFilter: false,
      };
      state.capability.providerRuntime = { open: async () => ({ provider: raw }) };
      const bound = (await open()).provider!;
      await expect(bound.search(request)).rejects.toThrow(message);
      expect(raw.search).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["kind", { kind: "project" as const }, "project candidates capability"],
    [
      "project filter",
      { kind: "trigger" as const, activeProjectKeys: ["repo"] },
      "project filter capability",
    ],
  ])(
    "rejects undeclared candidate %s before calling the provider",
    async (_name, request, message) => {
      const candidates = vi.fn(async () => ({ hits: [] }));
      const raw = { ...provider(), candidates };
      raw.capabilities = {
        sources: ["memory"],
        pagination: false,
        candidates: ["trigger"],
        projectFilter: false,
      };
      state.capability.providerRuntime = { open: async () => ({ provider: raw }) };
      const bound = (await open()).provider!;
      await expect(bound.candidates!(request)).rejects.toThrow(message);
      expect(candidates).not.toHaveBeenCalled();
    },
  );

  it("preserves frozen class receivers, statusless empty reads, and read pagination", async () => {
    class FrozenManager {
      #text = "";
      async search() {
        return [{ ...hit, snippet: this.#text }];
      }
      async readFile() {
        return {
          text: this.#text,
          path: "virtual:record",
          truncated: true,
          from: 4,
          lines: 2,
          nextFrom: 6,
        };
      }
      status() {
        return { backend: "builtin" as const, provider: "test" };
      }
      async probeEmbeddingAvailability() {
        return { ok: true };
      }
      async probeVectorAvailability() {
        return true;
      }
    }
    state.capability.runtime = legacy(Object.freeze(new FrozenManager()));
    const bound = (await open()).provider!;
    await expect(bound.search({ query: "q" })).resolves.toMatchObject({
      hits: [{ excerpt: "", reference: { providerId: "test-memory", id: "virtual:record" } }],
    });
    await expect(
      bound.get({
        reference: { providerId: "test-memory", id: "virtual:record" },
        from: 4,
        lines: 2,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      text: "",
      nextFrom: 6,
      from: 4,
      lines: 2,
      truncated: true,
    });
  });

  it("withholds legacy session hits without authorization and enumerates no candidates", async () => {
    const oldManager = manager();
    vi.spyOn(oldManager, "search").mockResolvedValue([{ ...hit, source: "sessions" }]);
    oldManager.listTriggerCandidates = async () => [{ ...hit, source: "sessions" }];
    const old: MemoryPluginRuntime = legacy(oldManager);
    state.capability.runtime = old;
    const bound = (await open()).provider!;
    await expect(bound.search({ query: "q" })).resolves.toMatchObject({ hits: [] });
    // Automatic recall consumers keep their legacy manager paths.
    expect(bound.capabilities).toEqual({
      sources: ["memory", "sessions"],
      pagination: false,
      candidates: [],
      projectFilter: true,
    });
    expect("candidates" in bound).toBe(false);
    expect(Object.isFrozen(bound.capabilities)).toBe(true);
    expect(Object.isFrozen(bound.capabilities.sources)).toBe(true);
    expect(Object.isFrozen(bound.capabilities.candidates)).toBe(true);
    const authorizeSearchHits = vi.fn(async () => []);
    old.authorizeSearchHits = authorizeSearchHits;
    await bound.search({ query: "q", lexicalOnly: true, activeProjectKeys: ["repo"] });
    expect(authorizeSearchHits).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:chat",
        sandboxed: true,
        trustedAgentScope: false,
      }),
    );
  });

  it("keeps authorized legacy session and keyless project hits ineligible for automatic recall", async () => {
    const oldManager = manager();
    const owner = { originClass: "owner", sessionKind: "interactive", observedAt: 1 } as const;
    vi.spyOn(oldManager, "search").mockResolvedValue([
      { ...hit, source: "sessions", provenance: owner, triggers: "remember" },
      { ...hit, provenance: owner, triggers: "remember", projectKey: ";" },
      { ...hit, provenance: owner, triggers: "remember" },
    ]);
    state.capability.runtime = {
      ...legacy(oldManager),
      authorizeSearchHits: async ({ hits }) => hits,
    };
    const bound = (await open()).provider!;
    try {
      const page = await bound.search({ query: "q" });
      expect(page.hits.map(({ automaticRecall }) => automaticRecall?.eligible)).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      await bound.close();
    }
  });

  it("reports legacy health without host filesystem paths", async () => {
    const oldManager = manager();
    vi.spyOn(oldManager, "status").mockReturnValue({
      backend: "builtin",
      provider: "test",
      files: 2,
      workspaceDir: "/home/owner/workspace",
      dbPath: "/home/owner/state/agent.sqlite",
      extraPaths: [{ path: "/home/owner/notes", kind: "directory" }],
      vector: { enabled: true, extensionPath: "/opt/sqlite-vec.dylib" },
    } as never);
    state.capability.runtime = legacy(oldManager);
    const bound = (await open()).provider!;
    try {
      const health = await bound.health();
      expect(health).toEqual({
        status: "ready",
        details: {
          legacy: { backend: "builtin", provider: "test", files: 2, vector: { enabled: true } },
        },
      });
    } finally {
      await bound.close();
    }
  });

  it.each(["search", "readFile"] as const)(
    "rejects a legacy manager missing %s",
    async (method) => {
      const oldManager = manager();
      Reflect.deleteProperty(oldManager, method);
      state.capability.runtime = legacy(oldManager);
      const bound = (await open()).provider!;
      try {
        const pending =
          method === "search"
            ? bound.search({ query: "q" })
            : bound.get({ reference: { providerId: "test-memory", id: "MEMORY.md" } });
        await expect(pending).rejects.toThrow(`memory runtime manager must implement ${method}`);
      } finally {
        await bound.close();
      }
    },
  );

  it("closes transient legacy managers without closing cached default managers", async () => {
    const oldManager = manager();
    oldManager.close = vi.fn(async () => {});
    state.capability.runtime = legacy(oldManager);
    await (await open()).provider!.close();
    expect(oldManager.close).not.toHaveBeenCalled();
    const result = await getActiveMemoryProviderCore({
      cfg: {},
      agentId: "main",
      context: context().value,
      purpose: "status",
    });
    await result.provider!.close();
    expect(oldManager.close).toHaveBeenCalledTimes(1);
  });

  it("uses the existing cleanup and reload owner for both runtime contracts", async () => {
    const old = { ...legacy(manager()), closeAllMemorySearchManagers: vi.fn(async () => {}) };
    const drain = vi.fn(async () => {});
    const resume = vi.fn();
    const current = {
      open: async () => ({ provider: provider() }),
      closeAllMemorySearchManagers: vi.fn(async () => {}),
      prepareReload: vi.fn(() => ({ drain, resume })),
    } satisfies MemoryProviderRuntime;
    state.capability = { runtime: old, providerRuntime: current };
    await closeActiveMemorySearchManagersCore();
    expect(old.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(current.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    const before = createEmptyPluginRegistry();
    before.memoryCapabilities.push({
      pluginId: "test-memory",
      capability: state.capability,
      memorySlotSelected: true,
    });
    const reload = prepareMemoryRuntimeReload(before, createEmptyPluginRegistry());
    await reload.close();
    reload.rollback();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

it.each(["before", "during"] as const)(
  "joins publications admitted %s provider open",
  async (when) => {
    const sessionKey = "agent:main:chat";
    const grant = await ownerAudience(sessionKey);
    const publication = createDeferredCore();
    const entered = createDeferredCore();
    const native = provider();
    const admit = () => {
      fakeSessionOwner.pendingKeys.add(sessionKey);
      fakeSessionOwner.publications.set(sessionKey, publication.promise);
    };
    const openProvider = vi.fn(async () => {
      if (when === "during") {
        admit();
      }
      entered.resolve();
      return { provider: native };
    });
    state.capability.providerRuntime = { open: openProvider };
    const caller = context();
    Reflect.set(caller.value.authority, "audience", grant.audience);
    if (when === "before") {
      admit();
    }
    const result = open(caller);
    const observed = result.catch((error: unknown) => error);
    try {
      if (when === "before") {
        expect(openProvider).not.toHaveBeenCalled();
      } else {
        await entered.promise;
      }
      fakeSessionOwner.pendingKeys.delete(sessionKey);
      fakeSessionOwner.publications.delete(sessionKey);
      publication.resolve();
      const opened = await result;
      expect(openProvider).toHaveBeenCalledOnce();
      await expect(opened.provider!.health()).resolves.toMatchObject({ status: "ready" });
      await opened.provider!.close();
    } finally {
      fakeSessionOwner.pendingKeys.delete(sessionKey);
      fakeSessionOwner.publications.delete(sessionKey);
      publication.resolve();
      await observed;
      grant.release();
    }
  },
);
