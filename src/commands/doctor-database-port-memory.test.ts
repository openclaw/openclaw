import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import type { getActiveMemorySearchManagerCore } from "../plugins/memory-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { rebuildPortedAgentMemory } from "./doctor-database-port-memory.js";

const plugin = vi.hoisted(() => ({
  open: vi.fn<typeof getActiveMemorySearchManagerCore>(),
}));

// The selected plugin is external I/O; physical custody and config loading stay real.
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/memory-runtime.js")>()),
  getActiveMemorySearchManagerCore: plugin.open,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", prefix: "port-memory-" });
});
afterEach(async () => {
  plugin.open.mockReset();
  try {
    await state.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

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

async function agentStores(agents: string[]) {
  const stores = agents.map((id) => path.join(state.agentDir(id), "openclaw-agent.sqlite"));
  await Promise.all(stores.map((store) => fs.mkdir(path.dirname(store), { recursive: true })));
  return stores;
}

function expectStatuses(
  results: Awaited<ReturnType<typeof rebuildPortedAgentMemory>>,
  expected: Record<string, "rebuilt" | "failed">,
) {
  expect(
    results
      .toSorted((left, right) => left.agentId.localeCompare(right.agentId))
      .map(({ agentId, status }) => [agentId, status]),
  ).toEqual(Object.entries(expected).toSorted(([left], [right]) => left.localeCompare(right)));
}

const fail = (message: string) => async () => {
  throw new Error(message);
};
const memoryAgent = (id: string) => ({
  memory: { search: { remote: { apiKey: { source: "env" as const, provider: "default", id } } } },
});

it("rebuilds under fresh configured custody and keeps that custody through plugin close", async () => {
  const stores = await agentStores(["main"]);
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

  const results = await rebuildPortedAgentMemory({ stateDir: state.stateDir, stores });
  expect(plugin.open.mock.calls[0]?.[0].cfg.agents?.entries?.main?.workspace).toBe(
    publishedWorkspace,
  );
  expect(results).toEqual([
    {
      agentId: "main",
      path: stores[0],
      status: "rebuilt",
      elapsedMs: expect.any(Number),
      files: 2,
      chunks: 7,
    },
  ]);
  expect(plugin.open).toHaveBeenCalledTimes(1);
  expect(() => memoryOwner?.assertCurrent()).toThrow();
  expect(captureGatewayStateOwner(state.statePath("state", "openclaw.sqlite"))).toBeUndefined();
});

it("reports one result per agent and continues after sync, dirty-state, and close failures", async () => {
  const agents = ["bad-sync", "dirty", "bad-close", "healthy"];
  await state.writeConfig({
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agents.map((id) => [id, {}])),
    },
  });
  const stores = await agentStores(agents);
  const selected = new Map([
    ["bad-sync", manager({ sync: fail("private provider response") })],
    [
      "dirty",
      manager({ status: () => ({ backend: "builtin", provider: "fixture", dirty: true }) }),
    ],
    ["bad-close", manager({ close: vi.fn(fail("private close response")) })],
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
  expectStatuses(results, {
    "bad-close": "failed",
    "bad-sync": "failed",
    dirty: "failed",
    healthy: "rebuilt",
  });
  for (const [agentId, close] of closeSpies) {
    expect(close, agentId).toHaveBeenCalledTimes(1);
  }
  for (const result of results.filter((candidate) => candidate.status === "failed")) {
    expect(result.warning).toContain(`openclaw memory index --agent ${result.agentId}`);
  }
  expect(JSON.stringify(results)).not.toContain("private provider response");
  expect(JSON.stringify(results)).not.toContain("private close response");
});

it("does not open unrelated, unconfigured, or retained custom-path memory stores", async () => {
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
  expectStatuses(results, { custom: "failed", main: "rebuilt", retired: "failed" });
  expect(plugin.open).toHaveBeenCalledTimes(1);
  expect(plugin.open.mock.calls[0]?.[0].agentId).toBe("main");
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith({ reason: "cli", force: true });
  expect(close).toHaveBeenCalledTimes(1);
  await expect(
    fs.stat(path.join(state.agentDir("custom"), "openclaw-agent.sqlite")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("resolves each agent's embedding SecretRef without a peer's missing key blocking it", async () => {
  vi.stubEnv("OPENCLAW_TEST_PORT_MEMORY_READY", "synthetic-memory-value");
  vi.stubEnv("OPENCLAW_TEST_PORT_MEMORY_MISSING", undefined);
  const agents = ["missing", "ready"];
  await state.writeConfig({
    memory: { search: { provider: "openai" } },
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(
        agents.map((agentId) => [
          agentId,
          memoryAgent(`OPENCLAW_TEST_PORT_MEMORY_${agentId.toUpperCase()}`),
        ]),
      ),
    },
  });
  const stores = await agentStores(agents);
  plugin.open.mockResolvedValue({ manager: manager(), searchRuntimeRegistered: true });

  const results = await rebuildPortedAgentMemory({ stateDir: state.stateDir, stores });
  expectStatuses(results, { missing: "failed", ready: "rebuilt" });
  expect(plugin.open).toHaveBeenCalledTimes(1);
  const acquired = plugin.open.mock.calls[0]?.[0];
  expect(acquired?.agentId).toBe("ready");
  expect(acquired?.cfg.agents?.entries?.ready?.memory?.search?.remote?.apiKey).toBe(
    "synthetic-memory-value",
  );
  expect(JSON.stringify(results)).not.toContain("synthetic-memory-value");
});
