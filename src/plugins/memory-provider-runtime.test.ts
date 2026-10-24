import { beforeEach, expect, it, vi } from "vitest";
import type { MemoryProviderStatus } from "../memory-host-sdk/host/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { delegateMemoryAudience, resolveMemoryAudienceFromEntry } from "./memory-audience.js";
import { fakeSessionOwner } from "./memory-audience.test-support.js";
import type {
  MemoryAudience,
  MemoryCallerContext,
  MemoryProviderHandle,
} from "./memory-provider-types.js";
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

function context(audience?: MemoryAudience) {
  let current = true;
  return {
    revoke() {
      current = false;
    },
    value: {
      authority: { kind: "session", sessionKey: "agent:main:chat", sandboxed: true, audience },
      assertCurrent() {
        if (!current) {
          throw new Error("caller revoked");
        }
      },
    } satisfies MemoryCallerContext,
  };
}
function provider(withCandidates = false) {
  const capabilities: MemoryProviderHandle["capabilities"] = {
    sources: ["memory"],
    pagination: false,
    candidates: withCandidates ? ["trigger"] : [],
    projectFilter: false,
  };
  return {
    capabilities,
    search: vi.fn<MemoryProviderHandle["search"]>(async () => ({ hits: [] })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
    ...(withCandidates ? { candidates: vi.fn(async () => ({ hits: [] })) } : {}),
  } satisfies MemoryProviderHandle;
}
function open(caller = context()) {
  return getActiveMemoryProviderCore({ cfg: {}, agentId: "main", context: caller.value });
}
function advertise(raw = provider()) {
  const openProvider = vi.fn(async () => ({ provider: raw }));
  state.capability.providerRuntime = { open: openProvider };
  return openProvider;
}

function legacy(searchManager: RegisteredMemorySearchManager) {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: searchManager })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
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
const readRange = { truncated: true, from: 4, lines: 2, nextFrom: 6 };
const read = { text: "", path: hit.path, ...readRange };
class LegacyManager implements RegisteredMemorySearchManager {
  #text = "";
  #snippet: string;
  constructor(snippet = hit.snippet) {
    this.#snippet = snippet;
  }
  async search() {
    return [{ ...hit, snippet: this.#snippet }];
  }
  async readFile() {
    return { ...read, text: this.#text };
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
function manager(): RegisteredMemorySearchManager {
  return new LegacyManager();
}
async function bind(raw = provider()) {
  advertise(raw);
  return (await open()).provider!;
}
async function withLegacy(
  old: MemoryPluginRuntime,
  check: (bound: MemoryProviderHandle) => Promise<void>,
) {
  state.capability.runtime = old;
  const bound = (await open()).provider!;
  try {
    await check(bound);
  } finally {
    await bound.close();
  }
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
it("rejects a minted audience used by a different session", async () => {
  const { audience } = await ownerAudience("agent:main:owner");
  const openProvider = advertise();
  const caller = context(audience);
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

it.each(["before", "during"])("rejects an audience invalidated %s provider open", async (when) => {
  const sessionKey = "agent:main:chat";
  const { audience, entry } = await ownerAudience(sessionKey);
  const raw = provider();
  const invalidate = () =>
    fakeSessionOwner.rows.set(sessionKey, { ...entry, lifecycleRevision: "generation-2" });
  const openProvider = vi.fn(async () => {
    invalidate();
    return { provider: raw };
  });
  state.capability.providerRuntime = { open: openProvider };
  if (when === "before") {
    invalidate();
  }
  await expect(open(context(audience))).rejects.toThrow("memory audience is no longer current");
  expect(openProvider).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  expect(raw.close).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  expect(raw.health).not.toHaveBeenCalled();
});

it("rejects a forged session audience before opening a provider", async () => {
  const openProvider = advertise();
  const caller = context({
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
  advertise(raw);
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
  ["handle", "capabilities", undefined],
  ["capability", "sources", []],
  ["capability", "sources", ["memory", "unknown"]],
  ["capability", "candidates", ["trigger"]],
  ["handle", "candidates", vi.fn()],
] as const)("closes a provider with invalid %s %s (%j)", async (target, key, value) => {
  const raw = provider();
  Reflect.set(target === "handle" ? raw : raw.capabilities, key, value);
  advertise(raw);
  await expect(open()).rejects.toThrow("valid capabilities with matching candidates");
  expect(raw.close).toHaveBeenCalledTimes(1);
});

type CapabilityRequest =
  | Parameters<MemoryProviderHandle["search"]>[0]
  | Parameters<NonNullable<MemoryProviderHandle["candidates"]>>[0];
it.each<[CapabilityRequest, string]>([
  [{ query: "q", sources: ["sessions"] }, "sessions source capability"],
  [{ query: "q", cursor: "next" }, "pagination capability"],
  [{ query: "q", activeProjectKeys: ["repo"] }, "project filter capability"],
  [{ kind: "project" }, "project candidates capability"],
  [{ kind: "trigger", activeProjectKeys: ["repo"] }, "project filter capability"],
])("rejects undeclared capability in %j", async (request, message) => {
  const raw = provider(true);
  const bound = await bind(raw);
  const pending = "query" in request ? bound.search(request) : bound.candidates!(request);
  await expect(pending).rejects.toThrow(message);
  expect("query" in request ? raw.search : raw.candidates).not.toHaveBeenCalled();
});

it("preserves frozen class receivers, statusless empty reads, and read pagination", async () => {
  state.capability.runtime = legacy(Object.freeze(new LegacyManager("")));
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
    ...readRange,
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
  const caps = bound.capabilities;
  expect([caps, caps.sources, caps.candidates].map(Object.isFrozen)).toEqual([true, true, true]);
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
  const recall = {
    ...hit,
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 1 } as const,
    triggers: "remember",
  };
  vi.spyOn(oldManager, "search").mockResolvedValue([
    { ...recall, source: "sessions" },
    { ...recall, projectKey: ";" },
    recall,
  ]);
  await withLegacy(
    {
      ...legacy(oldManager),
      authorizeSearchHits: async ({ hits }) => hits,
    },
    async (bound) => {
      const { hits } = await bound.search({ query: "q" });
      expect(hits.map(({ automaticRecall }) => automaticRecall?.eligible)).toEqual([
        false,
        false,
        true,
      ]);
    },
  );
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
  await withLegacy(legacy(oldManager), async (bound) => {
    const health = await bound.health();
    expect(health).toEqual({
      status: "ready",
      details: {
        legacy: { backend: "builtin", provider: "test", files: 2, vector: { enabled: true } },
      },
    });
  });
});

it.each<{
  name: string;
  facts: Partial<MemoryProviderStatus>;
  complete: boolean;
}>([
  {
    name: "pending embeddings after manager reacquisition",
    facts: { custom: { providerState: { mode: "pending" }, indexIdentity: { status: "valid" } } },
    complete: false,
  },
  {
    name: "incomplete vectors",
    facts: { vector: { enabled: true, index: { state: "incomplete" } } },
    complete: false,
  },
  {
    name: "unverified vectors",
    facts: { vector: { enabled: true, index: { state: "unverified" } } },
    complete: false,
  },
  {
    name: "degraded embedding provider",
    facts: {
      custom: { providerState: { mode: "degraded", providerId: "test", reason: "unavailable" } },
    },
    complete: false,
  },
  {
    name: "unavailable semantic provider with keyword fallback",
    facts: {
      provider: "none",
      requestedProvider: "openai",
      custom: {
        providerState: { mode: "fts-only", attemptedProviderId: "openai", reason: "unavailable" },
      },
    },
    complete: false,
  },
  {
    name: "intentional keyword-only index before lazy provider initialization",
    facts: {
      provider: "none",
      requestedProvider: "none",
      custom: { providerState: { mode: "pending", requestedProvider: "none" } },
    },
    complete: true,
  },
  { name: "dirty sources", facts: { dirty: true }, complete: false },
  { name: "failed sync", facts: { lastSyncError: "worker ran out of memory" }, complete: false },
  {
    name: "complete semantic index",
    facts: { vector: { enabled: true, index: { state: "complete" } } },
    complete: true,
  },
  {
    name: "empty semantic index",
    facts: { vector: { enabled: true, index: { state: "empty" } } },
    complete: true,
  },
  {
    name: "intentional keyword-only index",
    facts: {
      provider: "none",
      vector: { enabled: true, index: { state: "incomplete" } },
      custom: { searchMode: "fts-only", providerState: { mode: "fts-only" } },
    },
    complete: true,
  },
])("reports health and search coverage for $name", async ({ facts, complete }) => {
  const oldManager = manager();
  vi.spyOn(oldManager, "status").mockReturnValue({
    backend: "builtin",
    provider: "test",
    ...facts,
  });
  await withLegacy(legacy(oldManager), async (bound) => {
    const page = await bound.search({ query: "remember" });
    expect(page.hits).toHaveLength(1);
    expect(page.coverage).toBe(complete ? "complete" : "partial");
    const health = await bound.health();
    expect(health.status).toBe(complete ? "ready" : "degraded");
    if (!complete) {
      expect(page.warning).toEqual(expect.any(String));
      expect(health.message).toBe(page.warning);
    }
  });
});

it("returns authorized hits with partial coverage when optional status diagnostics fail", async () => {
  const oldManager = manager();
  oldManager.statusAsync = vi.fn(async () => {
    throw new Error("diagnostic worker unavailable");
  });
  await withLegacy(legacy(oldManager), async (bound) => {
    const page = await bound.search({ query: "remember" });
    expect(page.hits).toHaveLength(1);
    expect(page).toMatchObject({
      coverage: "partial",
      warning: expect.stringContaining("could not be verified"),
    });
    expect(oldManager.statusAsync).toHaveBeenCalledWith({ includeCounts: false });
    await expect(bound.health()).resolves.toMatchObject({
      status: "degraded",
      message: page.warning,
    });
  });
});

it.each(["search", "readFile"] as const)("rejects a legacy manager missing %s", async (method) => {
  const oldManager = manager();
  Reflect.set(oldManager, method, undefined);
  await withLegacy(legacy(oldManager), async (bound) => {
    const pending =
      method === "search"
        ? bound.search({ query: "q" })
        : bound.get({ reference: { providerId: "test-memory", id: "MEMORY.md" } });
    await expect(pending).rejects.toThrow(`memory runtime manager must implement ${method}`);
  });
});

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
    const caller = context(grant.audience);
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
