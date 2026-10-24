import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import type { getActiveMemorySearchManagerCore } from "../plugins/memory-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { rebuildPortedAgentMemory } from "./doctor-database-port-memory.js";

const plugin = vi.hoisted(() => ({
  open: vi.fn<typeof getActiveMemorySearchManagerCore>(),
}));

// The selected plugin is external I/O; physical custody and config loading stay real.
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/memory-runtime.js")>()),
  getActiveMemorySearchManagerCore: plugin.open,
}));

afterEach(() => plugin.open.mockReset());

function manager(overrides: Partial<MemorySearchManager> = {}): MemorySearchManager {
  return {
    search: async () => [],
    readFile: async ({ relPath }) => ({ status: "not_found", path: relPath, text: "" }),
    status: () => ({ backend: "builtin", provider: "fixture", dirty: false, files: 2, chunks: 7 }),
    sync: vi.fn(async () => {}),
    probeEmbeddingAvailability: async () => ({ ok: true }),
    probeVectorAvailability: async () => true,
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

it("rebuilds under fresh configured custody and keeps that custody through plugin close", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "port-memory-owner-" },
    async (state) => {
      const store = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(store), { recursive: true });
      const originalWorkspace = state.path("before-port");
      const publishedWorkspace = state.path("after-port");
      await state.writeConfig({ agents: { entries: { main: { workspace: originalWorkspace } } } });
      let previousOwner: ReturnType<typeof captureGatewayStateOwner>;
      await runWithLocalStateOwner({
        method: "database.port",
        params: {},
        target: state.stateDir,
        databasePortMaintenance: true,
        onForeignOwner: "refuse",
        runLocal: async ({ config }) => {
          expect(config.agents?.entries?.main?.workspace).toBe(originalWorkspace);
          previousOwner = captureGatewayStateOwner(state.statePath("state", "openclaw.sqlite"));
          expect(previousOwner?.role).toBe("sqlite-maintenance");
          await state.writeConfig({
            agents: { entries: { main: { workspace: publishedWorkspace } } },
          });
        },
      });
      expect(() => previousOwner?.assertCurrent()).toThrow();

      let memoryOwner: ReturnType<typeof captureGatewayStateOwner>;
      const selected = manager({
        sync: async () => {
          memoryOwner = captureGatewayStateOwner(state.statePath("state", "openclaw.sqlite"));
          expect(memoryOwner?.role).toBe("agent-embedded");
          expect(memoryOwner?.ownerId).not.toBe(previousOwner?.ownerId);
          expect(getScopedDatabaseEngineSelection()?.effectiveEngines.agent).toBe("sqlite");
        },
        close: async () => {
          expect(memoryOwner).toBeDefined();
          expect(() => memoryOwner?.assertCurrent()).not.toThrow();
        },
      });
      plugin.open.mockResolvedValue({ manager: selected, searchRuntimeRegistered: true });

      const results = await rebuildPortedAgentMemory({ stateDir: state.stateDir, stores: [store] });
      expect(plugin.open.mock.calls[0]?.[0].cfg.agents?.entries?.main?.workspace).toBe(
        publishedWorkspace,
      );
      expect(results).toEqual([
        {
          agentId: "main",
          path: store,
          status: "rebuilt",
          elapsedMs: expect.any(Number),
          files: 2,
          chunks: 7,
        },
      ]);
      expect(plugin.open).toHaveBeenCalledTimes(1);
      expect(() => memoryOwner?.assertCurrent()).toThrow();
      expect(captureGatewayStateOwner(state.statePath("state", "openclaw.sqlite"))).toBeUndefined();
    },
  );
});

it("reports one result per agent and continues after sync, dirty-state, and close failures", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "port-memory-failures-" },
    async (state) => {
      const agents = ["bad-sync", "dirty", "bad-close", "healthy"];
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agents.map((id) => [id, {}])),
        },
      });
      const stores = agents.map((id) => path.join(state.agentDir(id), "openclaw-agent.sqlite"));
      await Promise.all(stores.map((store) => fs.mkdir(path.dirname(store), { recursive: true })));
      const selected = new Map([
        [
          "bad-sync",
          manager({
            sync: async () => {
              throw new Error("private provider response");
            },
          }),
        ],
        [
          "dirty",
          manager({ status: () => ({ backend: "builtin", provider: "fixture", dirty: true }) }),
        ],
        [
          "bad-close",
          manager({
            close: vi.fn(async () => {
              throw new Error("private close response");
            }),
          }),
        ],
        ["healthy", manager()],
      ]);
      plugin.open.mockImplementation(async ({ agentId }) => ({
        manager: selected.get(agentId) ?? null,
        searchRuntimeRegistered: true,
      }));
      const closeSpies = [...selected].map(
        ([agentId, current]) => [agentId, vi.spyOn(current, "close")] as const,
      );

      const results = await rebuildPortedAgentMemory({ stateDir: state.stateDir, stores });
      expect(
        results
          .map(({ agentId, status }) => ({ agentId, status }))
          .toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual([
        { agentId: "bad-close", status: "failed" },
        { agentId: "bad-sync", status: "failed" },
        { agentId: "dirty", status: "failed" },
        { agentId: "healthy", status: "rebuilt" },
      ]);
      for (const [agentId, close] of closeSpies) {
        expect(close, agentId).toHaveBeenCalledTimes(1);
      }
      for (const result of results.filter((candidate) => candidate.status === "failed")) {
        expect(result.warning).toContain(`openclaw memory index --agent ${result.agentId}`);
      }
      expect(JSON.stringify(results)).not.toContain("private provider response");
      expect(JSON.stringify(results)).not.toContain("private close response");
    },
  );
});

it("does not open unrelated, unconfigured, or retained custom-path memory stores", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "port-memory-selection-" },
    async (state) => {
      const current = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
      const retained = path.join(state.agentDir("retired"), "openclaw-agent.sqlite");
      const customDir = state.path("custom-agent");
      const custom = path.join(customDir, "openclaw-agent.sqlite");
      const unrelated = path.join(state.agentDir("unrelated"), "openclaw-agent.sqlite");
      await Promise.all(
        [current, retained, custom, unrelated].map((store) =>
          fs.mkdir(path.dirname(store), { recursive: true }),
        ),
      );
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: { main: {}, custom: { agentDir: customDir }, unrelated: {} },
        },
      });
      const selected = manager();
      const sync = vi.spyOn(selected, "sync");
      const close = vi.spyOn(selected, "close");
      plugin.open.mockResolvedValue({ manager: selected, searchRuntimeRegistered: true });

      const results = await rebuildPortedAgentMemory({
        stateDir: state.stateDir,
        stores: [current, current, retained, custom],
      });
      expect(
        results
          .map(({ agentId, status }) => ({ agentId, status }))
          .toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual([
        { agentId: "custom", status: "failed" },
        { agentId: "main", status: "rebuilt" },
        { agentId: "retired", status: "failed" },
      ]);
      expect(plugin.open).toHaveBeenCalledTimes(1);
      expect(plugin.open.mock.calls[0]?.[0].agentId).toBe("main");
      expect(sync).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(
        fs.stat(path.join(state.agentDir("custom"), "openclaw-agent.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

it("resolves each agent's embedding SecretRef without a peer's missing key blocking it", async () => {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prefix: "port-memory-secrets-",
      env: {
        OPENCLAW_TEST_PORT_MEMORY_READY: "synthetic-memory-value",
        OPENCLAW_TEST_PORT_MEMORY_MISSING: undefined,
      },
    },
    async (state) => {
      const agents = ["missing", "ready"];
      await state.writeConfig({
        memory: { search: { provider: "openai" } },
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            agents.map((agentId) => [
              agentId,
              {
                memory: {
                  search: {
                    remote: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: `OPENCLAW_TEST_PORT_MEMORY_${agentId.toUpperCase()}`,
                      },
                    },
                  },
                },
              },
            ]),
          ),
        },
      });
      const stores = agents.map((agentId) =>
        path.join(state.agentDir(agentId), "openclaw-agent.sqlite"),
      );
      await Promise.all(stores.map((store) => fs.mkdir(path.dirname(store), { recursive: true })));
      plugin.open.mockResolvedValue({ manager: manager(), searchRuntimeRegistered: true });

      const results = await rebuildPortedAgentMemory({ stateDir: state.stateDir, stores });
      expect(
        results
          .map(({ agentId, status }) => ({ agentId, status }))
          .toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual([
        { agentId: "missing", status: "failed" },
        { agentId: "ready", status: "rebuilt" },
      ]);
      expect(plugin.open).toHaveBeenCalledTimes(1);
      const acquired = plugin.open.mock.calls[0]?.[0];
      expect(acquired?.agentId).toBe("ready");
      expect(acquired?.cfg.agents?.entries?.ready?.memory?.search?.remote?.apiKey).toBe(
        "synthetic-memory-value",
      );
      expect(JSON.stringify(results)).not.toContain("synthetic-memory-value");
    },
  );
});
