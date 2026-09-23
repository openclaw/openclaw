import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemoryProviderStatus, MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  createPluginStateKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
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
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));

vi.mock("../../plugins/memory-runtime.js", () => ({ getActiveMemorySearchManagerCore }));
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
      list: [{ id: "main", default: true }],
    },
  };
}

async function invokeMemorySearch(params: unknown, cfg: OpenClawConfig) {
  const respond = vi.fn();
  await expectDefined(
    memorySearchHandlers["memory.search"],
    'memorySearchHandlers["memory.search"] test invariant',
  )({
    req: { id: "memory-search-test" } as never,
    params: params as never,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function createStubManager() {
  return {
    search: vi.fn(async (): Promise<MemorySearchResult[]> => []),
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
    resolveDefaultAgentId.mockClear();
  });

  afterEach(async () => {
    await testState.cleanup();
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
      list: [{ id: "ops" }, { id: "research" }],
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
      list: [{ id: "main", default: true }, { id: configured }],
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
    const { memoryRuntime, configureMemoryCoreDreamingState } = await vi.importActual<{
      memoryRuntime: MemoryPluginRuntime;
      configureMemoryCoreDreamingState: (
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
      ) => void;
    }>("../../../extensions/memory-core/runtime-api.js");
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
