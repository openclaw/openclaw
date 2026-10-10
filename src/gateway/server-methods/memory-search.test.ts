import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  acquireGatewayLock,
  readLockPayloadSync,
  resolveGatewayLockPaths,
} from "../../infra/gateway-lock.js";
import type { MemoryProviderStatus, MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  createPluginStateKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "../../plugins/registry-contribution-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() => vi.fn());
const isActiveMemoryProviderNative = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore,
  isActiveMemoryProviderNative,
  resolveActiveMemoryBackendConfig,
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveDefaultAgentId,
}));

import { memorySearchHandlers } from "./memory-search.js";

let testState: OpenClawTestState;

function createConfig(workspaceDir: string): OpenClawConfig {
  return {
    memory: {
      search: {
        provider: "none",
        query: { minScore: 0 },
      },
    },
    agents: {
      defaults: { workspace: workspaceDir },
      entries: { main: {} },
    },
  };
}

async function invokeMemorySearch(
  params: unknown,
  cfg: OpenClawConfig,
  method = "memory.search",
  hasCurrentClientAuthority = () => true,
) {
  const respond = vi.fn();
  await expectDefined(
    memorySearchHandlers[method],
    'memorySearchHandlers["memory.search"] test invariant',
  )({
    req: { id: "memory-search-test" } as never,
    params: params as never,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    hasCurrentClientAuthority,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function createStubManager() {
  return {
    search: vi.fn<import("../../memory-host-sdk/host/types.js").MemorySearchManager["search"]>(
      async () => [],
    ),
    status: vi.fn((): MemoryProviderStatus => ({
      backend: "builtin" as const,
      provider: "none",
      dirty: false,
      custom: { searchMode: "fts-only" },
    })),
    close: vi.fn(async () => undefined),
  };
}

describe("memory.search gateway method", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "gateway-memory-search",
      layout: "state-only",
    });
    getActiveMemorySearchManagerCore.mockReset();
    resolveActiveMemoryBackendConfig.mockReset().mockReturnValue({ backend: "builtin" });
    isActiveMemoryProviderNative.mockReset().mockReturnValue(false);
    resolveDefaultAgentId.mockClear();
  });

  afterEach(async () => {
    await testState.cleanup();
  });

  async function withOwner(cfg: OpenClawConfig, run: (ownerId: string) => Promise<void>) {
    await testState.writeConfig(cfg);
    const owner = await acquireGatewayLock({ allowInTests: true, timeoutMs: 0 });
    assert(owner, "Expected a Gateway owner");
    const ownerId = readLockPayloadSync(
      resolveGatewayLockPaths(process.env).ownerLockPath,
      true,
    )?.ownerId;
    assert(ownerId, "Expected a Gateway owner identity");
    try {
      await run(ownerId);
    } finally {
      await owner.release();
    }
  }

  it("keeps CLI result limits, session scope, and rebuild diagnostics when routed", async () => {
    const cfg = createConfig(testState.workspaceDir);
    cfg.plugins = { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } };
    const manager = createStubManager();
    const notice = { sequence: 0, warning: "" };
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: true,
      lastSyncError: "fixture index unavailable",
      custom: { automaticRebuildNotice: notice },
    });
    const hits = Array.from({ length: 75 }, (_, index): MemorySearchResult => ({
      path: `memory/result-${index}.md`,
      startLine: 1,
      endLine: 1,
      score: 0.8,
      snippet: `Matching fact ${index}`,
      source: "memory",
    }));
    manager.search.mockImplementation(async (_query, options) => {
      notice.sequence += 1;
      notice.warning = "A keyword rebuild was attempted.";
      return hits.slice(0, options?.maxResults ?? 75);
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });
    await withOwner(cfg, async (expectedOwnerId) => {
      for (const maxResults of [0, -1, 1.5]) {
        const response = await invokeMemorySearch(
          { query: "matching fact", maxResults, expectedOwnerId },
          cfg,
          "memory.search.owner",
        );
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
      for (const maxResults of [undefined, 75]) {
        const response = await invokeMemorySearch(
          { query: " matching fact ", maxResults, minScore: 0.3, expectedOwnerId },
          cfg,
          "memory.search.owner",
        );
        expect(response).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            results: hits,
            stale: true,
            warning: expect.stringContaining("A keyword rebuild was attempted."),
            action: expect.stringContaining("openclaw memory status --index"),
          }),
          undefined,
        );
        expect(manager.search).toHaveBeenLastCalledWith(" matching fact ", {
          maxResults,
          minScore: 0.3,
          sessionKey: "agent:main:cli:direct:memory-search",
        });
      }
    });
    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      purpose: "cli",
      inspectSources: true,
    });
    expect(manager.close).toHaveBeenCalledTimes(2);
  });

  it("preserves routed disabled and failed acquisition outcomes for CLI rendering", async () => {
    const cfg = createConfig(testState.workspaceDir);
    await withOwner(cfg, async (expectedOwnerId) => {
      for (const error of [undefined, "fixture memory acquisition failed"]) {
        getActiveMemorySearchManagerCore.mockResolvedValueOnce({ manager: null, error });
        const response = await invokeMemorySearch(
          { query: "tea", expectedOwnerId },
          cfg,
          "memory.search.owner",
        );
        expect(response).toHaveBeenCalledExactlyOnceWith(
          true,
          error
            ? { agentId: "main", status: "failed", error }
            : { agentId: "main", status: "disabled" },
          undefined,
        );
      }
    });
  });

  it("reports routed cleanup failure as an uncertain outcome while preserving legacy cleanup", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.close.mockRejectedValue(new Error("fixture manager cleanup failed"));
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });
    await withOwner(cfg, async (expectedOwnerId) => {
      const legacy = await invokeMemorySearch({ query: "tea" }, cfg);
      expect(legacy).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ results: [] }),
        undefined,
      );
      const routed = await invokeMemorySearch(
        { query: "tea", expectedOwnerId },
        cfg,
        "memory.search.owner",
      );
      expect(routed).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "fixture manager cleanup failed" }),
      );
      expect(routed.mock.calls[0]?.[2]?.details?.mutationAccepted).not.toBe(false);
    });
  });

  it("records routed recalls before replying and refuses revoked or mismatched owners", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const { configureMemoryCoreDreamingState } = loadBundledPluginPublicArtifactModuleSync<{
      configureMemoryCoreDreamingState: (
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
      ) => void;
    }>({ dirName: "memory-core", artifactBasename: "runtime-api.js" });
    let current = true;
    let revokeOnRecall = false;
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStore<T>("memory-core", {
        ...options,
        env: testState.env,
      });
      if (revokeOnRecall && options.namespace === "short-term-recall") {
        current = false;
      }
      return store;
    });
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: false,
      workspaceDir: testState.workspaceDir,
    });
    const hit: MemorySearchResult = {
      path: "memory/2026-10-01.md",
      startLine: 1,
      endLine: 1,
      score: 0.8,
      snippet: "The owner prefers green tea.",
      source: "memory",
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 1000 },
    };
    manager.search.mockResolvedValue([hit]);
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });
    const recalls = createPluginStateKeyedStore<{ value: { recallCount: number } }>("memory-core", {
      namespace: "short-term-recall",
      maxEntries: 50_000,
      env: testState.env,
    });
    await withOwner(cfg, async (expectedOwnerId) => {
      const invalid = await invokeMemorySearch(
        { query: "tea", expectedOwnerId: "replaced-owner" },
        cfg,
        "memory.search.owner",
      );
      expect(invalid).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(manager.search).not.toHaveBeenCalled();
      const response = await invokeMemorySearch(
        { query: "tea", expectedOwnerId },
        cfg,
        "memory.search.owner",
      );
      expect(response).toHaveBeenCalledWith(true, { results: [hit] }, undefined);
      expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([1]);
      manager.search.mockImplementationOnce(async () => {
        current = false;
        return [hit];
      });
      const revoked = await invokeMemorySearch(
        { query: "tea", expectedOwnerId },
        cfg,
        "memory.search.owner",
        () => current,
      );
      expect(revoked).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
      expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([1]);
      current = true;
      revokeOnRecall = true;
      const duringRecall = await invokeMemorySearch(
        { query: "tea", expectedOwnerId },
        cfg,
        "memory.search.owner",
        () => current,
      );
      expect(current).toBe(false);
      expect(duringRecall).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
      const locks = createPluginStateKeyedStore("memory-core", {
        namespace: "short-term-locks",
        maxEntries: 4096,
        env: testState.env,
      });
      expect(await locks.entries()).toEqual([]);
      expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([1]);
    });
  });

  it("rejects a missing or whitespace-only query before acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    for (const params of [{}, { query: "   " }]) {
      const respond = await invokeMemorySearch(params, cfg);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "query must be a non-empty string",
        }),
      );
    }
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("keeps automatic rebuild disclosure when subsequent retrieval fails", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    const notice = { sequence: 0, warning: "" };
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: false,
      custom: { automaticRebuildNotice: notice },
    });
    manager.search.mockImplementation(async () => {
      notice.sequence += 1;
      notice.warning =
        "Rebuilding may call the configured embedding provider and can incur provider cost.";
      throw new Error("query retrieval failed");
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });
    const respond = await invokeMemorySearch({ query: "alpha" }, cfg);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining(notice.warning) }),
    );
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it.each([
    { requested: 100, expected: 50 },
    { requested: 0, expected: 1 },
  ])("clamps maxResults=$requested to $expected", async ({ requested, expected }) => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    await invokeMemorySearch({ query: "lantern", maxResults: requested, minScore: 0.42 }, cfg);

    expect(manager.search).toHaveBeenCalledWith("lantern", {
      maxResults: expected,
      minScore: 0.42,
    });
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it("rejects an unknown agentId without acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    const respond = await invokeMemorySearch({ query: "lantern", agentId: "invented" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown agentId",
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("returns typed selection-required when an explicit fleet omits agentId", async () => {
    const cfg = createConfig(testState.workspaceDir);
    cfg.agents = {
      ...cfg.agents,
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    resolveDefaultAgentId.mockImplementationOnce(() => {
      throw new AgentSelectionRequiredError(["ops", "research"], {
        surface: "memory search",
        hint: "Pass agentId to select a configured agent.",
      });
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("rejects a non-string agentId without acquiring a manager", async () => {
    const cfg = createConfig(testState.workspaceDir);

    const respond = await invokeMemorySearch({ query: "lantern", agentId: 42 }, cfg);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agentId must be a string",
      }),
    );
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it.each(["   ", "---", "ſ"])(
    "rejects a normalization-empty agentId without acquiring a manager: %j",
    async (agentId) => {
      const cfg = createConfig(testState.workspaceDir);

      const respond = await invokeMemorySearch({ query: "lantern", agentId }, cfg);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "unknown agentId",
        }),
      );
      expect(resolveDefaultAgentId).not.toHaveBeenCalled();
      expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    { configured: "research", requested: "Research" },
    { configured: "_", requested: "_" },
  ])("searches configured non-default agent $configured", async ({ configured, requested }) => {
    const cfg = createConfig(testState.workspaceDir);
    cfg.agents = {
      ...cfg.agents,
      entries: { main: {}, [configured]: {} },
    };
    const result = {
      path: "memory/project-lantern.md",
      startLine: 2,
      endLine: 2,
      score: 0.75,
      snippet: "The launch window opens at sunrise.",
      source: "memory" as const,
    };
    const manager = createStubManager();
    manager.search.mockResolvedValue([result]);
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "lantern", agentId: requested }, cfg);

    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledWith({
      cfg,
      agentId: configured,
      purpose: "cli",
    });
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: configured,
        provider: "none",
        searchMode: "fts-only",
        results: [result],
      },
      undefined,
    );
  });

  it("returns unavailable when no memory manager is configured", async () => {
    const cfg: OpenClawConfig = {};
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: null,
      error: "memory plugin unavailable",
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, cfg);

    expect(resolveDefaultAgentId).toHaveBeenCalledWith(cfg, {
      surface: "memory search",
      hint: "Pass agentId to select a configured agent.",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "memory plugin unavailable",
      }),
    );
  });

  it("does not ask a legacy memory runtime for its backend before searching", async () => {
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: null,
      error: "memory plugin unavailable",
    });

    await invokeMemorySearch({ query: "lantern" }, {});

    expect(isActiveMemoryProviderNative).toHaveBeenCalledWith({ cfg: {}, agentId: "main" });
    expect(resolveActiveMemoryBackendConfig).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledOnce();
  });

  it("does not qualify routine pending index work as a search failure", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: true,
      custom: { searchMode: "fts-only" },
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
      },
      undefined,
    );
  });

  it("qualifies results after automatic indexing fails", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      dirty: true,
      lastSyncError: "embedding request timed out",
      custom: { searchMode: "fts-only" },
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
        stale: true,
        warning:
          "Memory index is stale: embedding request timed out. Search results may be incomplete.",
        action:
          "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.",
      },
      undefined,
    );
  });

  it("preserves OpenClaw index ownership and configured provider intent", async () => {
    const cfg = createConfig(testState.workspaceDir);
    const manager = createStubManager();
    manager.status.mockReturnValue({
      backend: "builtin",
      provider: "none",
      requestedProvider: "openai",
      dirty: true,
      custom: {
        searchMode: "fts-only",
        indexIdentity: {
          status: "mismatched",
          reason: "index provenance classifier changed",
          code: "provenance_version",
          owner: "openclaw",
        },
      },
    });
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, cfg);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
        stale: true,
        warning:
          "Memory index is stale: index provenance classifier changed (owner: openclaw, code: provenance_version). Search results may be incomplete.",
        action:
          "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
      },
      undefined,
    );
  });

  it("shares one format repair across concurrent transient Gateway searches", async () => {
    const { createMemoryRuntime, configureMemoryCoreDreamingState } = await vi.importActual<{
      createMemoryRuntime: (host: {
        runInBackgroundContext: <T>(run: () => T) => T;
      }) => MemoryPluginRuntime;
      configureMemoryCoreDreamingState: (
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
      ) => void;
    }>("../../../extensions/memory-core/runtime-api.js");
    const memoryRuntime = createMemoryRuntime({ runInBackgroundContext: (run) => run() });
    const stateEnv = testState.env;
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStore<T>("memory-core", { ...options, env: stateEnv }),
    );
    const cfg: OpenClawConfig = {
      ...createConfig(testState.workspaceDir),
      plugins: { enabled: false },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          store: { vector: { enabled: false } },
          query: { minScore: 0 },
        },
      },
    };
    const memoryDir = path.join(testState.workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "orchard.md"),
      "# Orchard\nJuniper orchard uses copper lanterns.\n",
    );
    let db: DatabaseSync | undefined;
    try {
      const seeded = await memoryRuntime.getMemorySearchManager({
        cfg,
        agentId: "main",
        purpose: "cli",
      });
      assert(seeded.manager?.sync, seeded.error ?? "Expected a memory index manager");
      await seeded.manager.sync({ reason: "cli", force: true });
      const dbPath = seeded.manager.status().dbPath;
      assert(dbPath, "Expected a memory index database path");
      await seeded.manager.close?.();
      db = new DatabaseSync(dbPath);
      const database = db;
      const readRevision = () => {
        const row = database.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
        assert(typeof row?.revision === "number", "Expected a memory index revision");
        return row.revision;
      };
      const markOldProvenance = () => {
        database
          .prepare(
            "UPDATE memory_index_meta SET value = json_set(value, '$.provenanceVersion', 0) WHERE key = 'memory_index_meta_v1'",
          )
          .run();
      };
      const expectRecall = (respond: Awaited<ReturnType<typeof invokeMemorySearch>>) => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            warning: expect.stringContaining("does not call an embedding provider"),
            results: [
              expect.objectContaining({
                path: "memory/orchard.md",
                snippet: expect.stringContaining("copper lanterns"),
              }),
            ],
          }),
          undefined,
        );
      };
      getActiveMemorySearchManagerCore.mockImplementation((params) =>
        memoryRuntime.getMemorySearchManager(params),
      );
      markOldProvenance();
      const beforeControl = readRevision();
      expectRecall(await invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg));
      // A rebuild writes several rows. Measure one real repair instead of assuming a fixed count.
      const singleRepairWrites = readRevision() - beforeControl;
      expect(singleRepairWrites).toBeGreaterThan(0);

      markOldProvenance();
      const beforeConcurrent = readRevision();
      const acquired: RegisteredMemorySearchManager[] = [];
      const bothAcquired = createDeferredCore();
      getActiveMemorySearchManagerCore.mockImplementation(async (params) => {
        const result = await memoryRuntime.getMemorySearchManager(params);
        if (result.manager) {
          acquired.push(result.manager);
        }
        if (!result.manager || acquired.length === 2) {
          bothAcquired.resolve();
        }
        await bothAcquired.promise;
        return result;
      });
      const responses = await Promise.all([
        invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg),
        invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg),
      ]);
      expect(acquired).toHaveLength(2);
      expect(acquired[0]).not.toBe(acquired[1]);
      responses.forEach(expectRecall);
      expect(readRevision() - beforeConcurrent).toBe(singleRepairWrites);
    } finally {
      await memoryRuntime.closeAllMemorySearchManagers?.();
      db?.close();
    }
  });
});
