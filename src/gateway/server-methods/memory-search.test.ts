import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
} from "../../plugin-state/plugin-state-store.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
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
let testConfig: OpenClawConfig;
const { createMemoryRuntime: createCliMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: object) => {
    searchForCli: NonNullable<MemoryPluginRuntime["searchForCli"]>;
  };
}>("../../../extensions/memory-core/runtime-api.js");
const searchForCli = createCliMemoryRuntime({}).searchForCli;

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
  respond = vi.fn(),
) {
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

function expectSuccess(respond: ReturnType<typeof vi.fn>, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: object) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function createStubManager(status?: MemoryProviderStatus) {
  const manager = {
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
  if (status) {
    manager.status.mockReturnValue(status);
  }
  return manager;
}

describe("memory.search gateway method", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "gateway-memory-search",
      layout: "state-only",
    });
    testConfig = createConfig(testState.workspaceDir);
    setRuntimeConfigSnapshot({});
    getActiveMemorySearchManagerCore.mockReset();
    resolveActiveMemoryBackendConfig.mockReset().mockReturnValue({ backend: "builtin" });
    isActiveMemoryProviderNative.mockReset().mockReturnValue(false);
    resolveDefaultAgentId.mockClear();
  });

  afterEach(async () => {
    await testState.cleanup();
    clearRuntimeConfigSnapshot();
  });

  async function withOwner(
    cfg: OpenClawConfig,
    run: (
      search: (
        params: Record<string, unknown>,
        current?: () => boolean,
        respond?: ReturnType<typeof vi.fn>,
      ) => ReturnType<typeof invokeMemorySearch>,
    ) => Promise<void>,
  ) {
    await testState.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const owner = await acquireGatewayLock({ allowInTests: true, timeoutMs: 0 });
    assert(owner, "Expected a Gateway owner");
    const ownerId = readLockPayloadSync(
      resolveGatewayLockPaths(process.env).ownerLockPath,
      true,
    )?.ownerId;
    assert(ownerId, "Expected a Gateway owner identity");
    try {
      await run((params, current, respond) =>
        invokeMemorySearch(
          { expectedOwnerId: ownerId, ...params },
          cfg,
          "memory.search.owner",
          current,
          respond,
        ),
      );
    } finally {
      await owner.release();
    }
  }

  it("keeps CLI result limits, session scope, and rebuild diagnostics when routed", async () => {
    testConfig.plugins = {
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    };

    const notice = { sequence: 0, warning: "" };
    const manager = createStubManager({
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
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager, searchForCli });
    await withOwner(testConfig, async (search) => {
      for (const maxResults of [0, 1.5]) {
        const response = await search({ query: "matching fact", maxResults });
        expectFailure(response, { code: "INVALID_REQUEST" });
      }
      expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
      for (const maxResults of [undefined, 75]) {
        const response = await search({ query: " matching fact ", maxResults, minScore: 0.3 });
        expectSuccess(
          response,
          expect.objectContaining({
            results: hits,
            stale: true,
            warning: expect.stringContaining("A keyword rebuild was attempted."),
            action: expect.stringContaining("openclaw memory status --index"),
          }),
        );
        expect(manager.search).toHaveBeenLastCalledWith(" matching fact ", {
          maxResults,
          minScore: 0.3,
          sessionKey: "agent:main:cli:direct:memory-search",
        });
      }
    });
  });

  it("preserves routed disabled and failed acquisition outcomes for CLI rendering", async () => {
    await withOwner(testConfig, async (search) => {
      for (const error of [undefined, "fixture memory acquisition failed"]) {
        getActiveMemorySearchManagerCore.mockResolvedValueOnce({ manager: null, error });
        const response = await search({ query: "tea" });
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

  it("delivers routed results before cleanup and preserves them if cleanup fails", async () => {
    const manager = createStubManager();
    manager.close.mockRejectedValue(new Error("fixture manager cleanup failed"));
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager, searchForCli });
    await withOwner(testConfig, async (search) => {
      const legacy = await invokeMemorySearch({ query: "tea" }, testConfig);
      expectSuccess(legacy, expect.objectContaining({ results: [] }));
      const closeStarted = createDeferredCore();
      const releaseClose = createDeferredCore();
      manager.close.mockImplementationOnce(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        throw new Error("fixture manager cleanup failed");
      });
      const routed = vi.fn();
      let requestSettled = false;
      const request = search({ query: "tea" }, () => true, routed).then(() => {
        requestSettled = true;
      });
      try {
        await closeStarted.promise;
        expect(routed).toHaveBeenCalledExactlyOnceWith(true, { results: [] }, undefined);
        expect(requestSettled).toBe(false);
      } finally {
        releaseClose.resolve();
        await request;
      }
      expect(routed).toHaveBeenCalledTimes(1);
      expect(manager.close).toHaveBeenCalledTimes(2);
    });
  });

  it("records routed recalls before replying and refuses revoked or mismatched owners", async () => {
    const { configureMemoryCoreDreamingState } =
      loadBundledPluginPublicArtifactModuleSync<MemoryRuntimeModule>({
        dirName: "memory-core",
        artifactBasename: "runtime-api.js",
      });
    let current = true;
    let revokeOnRecall = false;
    const instance = new PluginInstance("memory-core");
    instance.run(() =>
      configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
        const store = createPluginStateKeyedStore<T>("memory-core", {
          ...options,
          env: testState.env,
        });
        if (revokeOnRecall && options.namespace === "short-term-recall") {
          current = false;
        }
        return store;
      }),
    );

    const manager = createStubManager({
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
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager,
      searchForCli: instance.wrap(searchForCli),
    });
    const recalls = createPluginStateKeyedStore<{ value: { recallCount: number } }>("memory-core", {
      namespace: "short-term-recall",
      maxEntries: 50_000,
      env: testState.env,
    });
    try {
      await withOwner(testConfig, async (search) => {
        const invalid = await search({ query: "tea", expectedOwnerId: "replaced-owner" });
        expectFailure(invalid, { code: "UNAVAILABLE" });
        expect(manager.search).not.toHaveBeenCalled();
        getActiveMemorySearchManagerCore.mockImplementationOnce(async () => {
          current = false;
          return { manager, searchForCli: instance.wrap(searchForCli) };
        });
        const duringAcquisition = await search({ query: "tea" }, () => current);
        expect(duringAcquisition).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(manager.search).not.toHaveBeenCalled();
        expect(manager.close).toHaveBeenCalledOnce();
        current = true;
        const response = await search({ query: "tea" });
        expectSuccess(response, { results: [hit] });
        expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([
          1,
        ]);
        manager.search.mockImplementationOnce(async () => {
          current = false;
          return [hit];
        });
        const revoked = await search({ query: "tea" }, () => current);
        expect(revoked).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([
          1,
        ]);
        current = true;
        revokeOnRecall = true;
        const duringRecall = await search({ query: "tea" }, () => current);
        expect(current).toBe(false);
        expect(duringRecall).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        const locks = createPluginStateKeyedStore("memory-core", {
          namespace: "short-term-locks",
          maxEntries: 4096,
          env: testState.env,
        });
        expect(await locks.entries()).toEqual([]);
        expect((await recalls.entries()).map((entry) => entry.value.value.recallCount)).toEqual([
          1,
        ]);
      });
    } finally {
      await instance.dispose();
    }
  });

  it("rejects a missing or whitespace-only query before acquiring a manager", async () => {
    for (const params of [{}, { query: "   " }]) {
      const respond = await invokeMemorySearch(params, testConfig);
      expectFailure(respond, {
        code: "INVALID_REQUEST",
        message: "query must be a non-empty string",
      });
    }
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("keeps automatic rebuild disclosure when subsequent retrieval fails", async () => {
    const notice = { sequence: 0, warning: "" };
    const manager = createStubManager({
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
    const respond = await invokeMemorySearch({ query: "alpha" }, testConfig);
    expectFailure(respond, { message: expect.stringContaining(notice.warning) });
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it.each([
    { requested: 100, expected: 50 },
    { requested: 0, expected: 1 },
  ])("clamps maxResults=$requested to $expected", async ({ requested, expected }) => {
    const manager = createStubManager();
    getActiveMemorySearchManagerCore.mockResolvedValue({ manager });

    await invokeMemorySearch(
      { query: "lantern", maxResults: requested, minScore: 0.42 },
      testConfig,
    );

    expect(manager.search).toHaveBeenCalledWith("lantern", {
      maxResults: expected,
      minScore: 0.42,
    });
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["invented", "unknown agentId"],
    [42, "agentId must be a string"],
    ["   ", "unknown agentId"],
  ])("rejects invalid agentId %j before acquiring a manager", async (agentId, message) => {
    expectFailure(await invokeMemorySearch({ query: "lantern", agentId }, testConfig), {
      code: "INVALID_REQUEST",
      message,
    });
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it("returns typed selection-required when an explicit fleet omits agentId", async () => {
    testConfig.agents = {
      ...testConfig.agents,
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    resolveDefaultAgentId.mockImplementationOnce(() => {
      throw new AgentSelectionRequiredError(["ops", "research"]);
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, testConfig);

    expectFailure(respond, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("agent"),
    });
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  it.each([
    { configured: "research", requested: "Research" },
    { configured: "_", requested: "_" },
  ])("searches configured non-default agent $configured", async ({ configured, requested }) => {
    testConfig.agents = {
      ...testConfig.agents,
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

    const respond = await invokeMemorySearch({ query: "lantern", agentId: requested }, testConfig);

    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expectSuccess(respond, {
      agentId: configured,
      provider: "none",
      searchMode: "fts-only",
      results: [result],
    });
  });

  it("returns unavailable when no memory manager is configured", async () => {
    const cfg: OpenClawConfig = {};
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: null,
      error: "memory plugin unavailable",
    });

    const respond = await invokeMemorySearch({ query: "lantern" }, cfg);

    expectFailure(respond, {
      code: "UNAVAILABLE",
      message: "memory plugin unavailable",
    });
    expect(isActiveMemoryProviderNative).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(resolveActiveMemoryBackendConfig).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledOnce();
  });

  it("preserves OpenClaw index ownership and configured provider intent", async () => {
    const manager = createStubManager({
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

    const respond = await invokeMemorySearch({ query: "hidden codeword" }, testConfig);

    expectSuccess(respond, {
      agentId: "main",
      provider: "none",
      searchMode: "fts-only",
      results: [],
      stale: true,
      warning:
        "Memory index is stale: index provenance classifier changed (owner: openclaw, code: provenance_version). Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it("shares one format repair across concurrent transient Gateway searches", async () => {
    const { createMemoryRuntime, configureMemoryCoreDreamingState } =
      await vi.importActual<MemoryRuntimeModule>("../../../extensions/memory-core/runtime-api.js");
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
      const expectRecall = (
        respond: Awaited<ReturnType<typeof invokeMemorySearch>>,
        repaired = true,
      ) => {
        expectSuccess(
          respond,
          expect.objectContaining({
            ...(repaired
              ? { warning: expect.stringContaining("does not call an embedding provider") }
              : {}),
            results: [
              expect.objectContaining({
                path: "memory/orchard.md",
                snippet: expect.stringContaining("copper lanterns"),
              }),
            ],
          }),
        );
        if (!repaired) {
          expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("stale");
          expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("warning");
        }
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
      const observer = await memoryRuntime.getMemorySearchManager({
        cfg,
        agentId: "main",
        purpose: "cli",
      });
      assert(observer.manager, observer.error ?? "Expected a memory index observer");
      const beforeConcurrent = readRevision();
      const acquired: RegisteredMemorySearchManager[] = [];
      const bothSearching = createDeferredCore();
      let searching = 0;
      getActiveMemorySearchManagerCore.mockImplementation(async (params) => {
        const result = await memoryRuntime.getMemorySearchManager(params);
        if (result.manager) {
          acquired.push(result.manager);
          const search = result.manager.search.bind(result.manager);
          vi.spyOn(result.manager, "search").mockImplementationOnce(async (...args) => {
            if (++searching === 2) {
              bothSearching.resolve();
            }
            await bothSearching.promise;
            return search(...args);
          });
        } else {
          bothSearching.resolve();
        }
        return result;
      });
      const responses = await Promise.all([
        invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg),
        invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg),
      ]);
      expect(acquired).toHaveLength(2);
      expect(acquired[0]).not.toBe(acquired[1]);
      responses.forEach((response) => expectRecall(response));
      expect(readRevision() - beforeConcurrent).toBe(singleRepairWrites);
      getActiveMemorySearchManagerCore.mockResolvedValueOnce(observer);
      expectRecall(await invokeMemorySearch({ query: "Juniper", agentId: "main" }, cfg), false);
      expect(readRevision() - beforeConcurrent).toBe(singleRepairWrites);
    } finally {
      await memoryRuntime.closeAllMemorySearchManagers?.();
      db?.close();
    }
  });
});
