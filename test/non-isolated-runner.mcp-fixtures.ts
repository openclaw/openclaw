import path from "node:path";

export function mcpManagerFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const imports = `import { expect, it, vi } from "vitest";
const key = Symbol.for("openclaw.sessionMcpRuntimeManager");
const probeKey = Symbol.for("fixture.sessionMcpManager");
async function fixtureManager() {
  const { bindSessionMcpRuntimeTestScheduler } = await import(${source("agents/agent-bundle-mcp-manager.test-support.ts")});
  await bindSessionMcpRuntimeTestScheduler();
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  return getSessionMcpRuntimeManagerForTesting();
}
`;
  return {
    "09-mcp-a-mocked-owner.test.ts": `${imports}
vi.mock(${source("plugins/plugin-metadata-snapshot.ts")}, () => ({}));
it("retains a real MCP manager created under a file-owned metadata mock", async () => {
  const manager = await fixtureManager();
  await manager.disposeAll();
  expect(globalThis[key]).toBe(manager);
});
`,
    "09-mcp-b-installed-bundle.test.ts": `import ${source("agents/agent-bundle-mcp-runtime.agent-bundle.test.ts")};
`,
    "09-mcp-c-replaced-owner.test.ts": `${imports}
it("cancels the agent before publishing a successor during MCP disposal", async () => {
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "replacement", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const join = lease.runtime.joinCleanup.bind(lease.runtime);
  await vi.resetModules();
  const { createSessionMcpRuntimeManager } = await import(${source("agents/agent-bundle-mcp-manager.test-support.ts")});
  const successor = createSessionMcpRuntimeManager();
  const probe = globalThis[probeKey] = { successor, joined: false, cancelled: false };
  let cancel;
  const cancelled = new Promise(resolve => { cancel = resolve; });
  const { ACTIVE_EMBEDDED_RUNS } = await import(${source("agents/embedded-agent-runner/run-state.ts")});
  ACTIVE_EMBEDDED_RUNS.set("mcp-dependent-run", { cancel() { probe.cancelled = true; cancel(); } });
  lease.runtime.joinCleanup = async () => {
    expect(probe.cancelled, "agent cancellation must release the MCP cleanup barrier").toBe(true);
    await cancelled;
    await join();
    globalThis[key] = successor;
    probe.joined = true;
  };
});
`,
    "09-mcp-d-current-owner.test.ts": `${imports}
it("keeps the replacement MCP manager usable after prior-owner cleanup", async () => {
  const probe = globalThis[probeKey];
  expect(probe.joined).toBe(true);
  expect(probe.cancelled).toBe(true);
  expect(globalThis[key]).toBe(probe.successor);
  const { acquireSessionMcpRuntime } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const lease = await acquireSessionMcpRuntime({ sessionId: "successor", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false } } });
  expect(lease.runtime.sessionId).toBe("successor");
  lease.releaseLease();
  delete globalThis[probeKey];
});
`,
    "09-mcp-e-mocked-disposer.test.ts": `${imports}
it("leaves a retained MCP session behind a file-owned disposal spy", async () => {
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "mocked-dispose", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  globalThis[probeKey] = { manager };
  vi.spyOn(manager, "disposeAll").mockResolvedValue(undefined);
});
`,
    "09-mcp-f-disposal-custody.test.ts": `${imports}
it("restores the MCP disposal spy and closes its real owner", () => {
  const { manager } = globalThis[probeKey];
  expect(globalThis[key]).toBeUndefined();
  expect(manager.listRuntimeKeys()).toEqual([]);
  delete globalThis[probeKey];
});
`,
    "97-mcp-a-cancel-failure.test.ts": `${imports}
import path from "node:path";
it("keeps run-owned resources when cancellation fails", async () => {
  const runState = await import(${source("agents/embedded-agent-runner/run-state.ts")});
  const { openOpenClawStateDatabase } = await import(${source("state/openclaw-state-db.ts")});
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "cancel-failure", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: path.join(import.meta.dirname, "cancel-state") } });
  const handle = { cancel() { throw new Error("Synthetic run cancellation failed"); } };
  const baseline = {
    env: process.env.OPENCLAW_MCP_CANCEL_FIXTURE,
    global: globalThis.__openclawMcpCancelFixture,
    hasGlobal: Object.hasOwn(globalThis, "__openclawMcpCancelFixture"),
  };
  const probe = globalThis[probeKey] = { manager, runState, database, handle, baseline, closes: 0 };
  vi.stubEnv("OPENCLAW_MCP_CANCEL_FIXTURE", "file-owned");
  vi.stubGlobal("__openclawMcpCancelFixture", "file-owned");
  const join = lease.runtime.joinCleanup.bind(lease.runtime);
  lease.runtime.joinCleanup = async () => { probe.closes++; await join(); };
  runState.ACTIVE_EMBEDDED_RUNS.set("cancel-failure", handle);
});
`,
    "97-mcp-b-cancel-custody.test.ts": `${imports}
it("preserves active runs and their module, MCP and database owners after failed cancellation", async () => {
  const probe = globalThis[probeKey];
  const runState = await import(${source("agents/embedded-agent-runner/run-state.ts")});
  try {
    expect(process.env.OPENCLAW_MCP_CANCEL_FIXTURE, "file environment must be restored after failed cancellation").toBe(probe.baseline.env);
    expect(globalThis.__openclawMcpCancelFixture, "file global must be restored after failed cancellation").toBe(probe.baseline.global);
    expect(Object.hasOwn(globalThis, "__openclawMcpCancelFixture")).toBe(probe.baseline.hasGlobal);
    expect(probe.closes, "MCP disposal must not follow failed run cancellation").toBe(0);
    expect(globalThis[key]).toBe(probe.manager);
    expect(probe.database.db.isOpen).toBe(true);
    expect(runState).toBe(probe.runState);
    expect(runState.ACTIVE_EMBEDDED_RUNS.get("cancel-failure")).toBe(probe.handle);
  } finally {
    probe.runState.ACTIVE_EMBEDDED_RUNS.delete("cancel-failure");
    await probe.manager.disposeAll();
    const { closeOpenClawStateDatabaseAsync } = await import(${source("state/openclaw-state-db.ts")});
    await closeOpenClawStateDatabaseAsync();
    delete globalThis[probeKey];
  }
});
`,
    "98-mcp-a-direct-disposer.test.ts": `${imports}
it("replaces a retained MCP manager disposer without a restorable spy", async () => {
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "mocked-dispose", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  globalThis[probeKey] = { manager, dispose: manager.disposeAll.bind(manager) };
  manager.disposeAll = vi.fn(async () => undefined);
});
`,
    "98-mcp-b-direct-custody.test.ts": `${imports}
it("retains MCP custody when the file mocked its disposer", async () => {
  const { manager, dispose } = globalThis[probeKey];
  expect(globalThis[key]).toBe(manager);
  expect(manager.listRuntimeKeys()).toEqual(["mocked-dispose"]);
  await dispose();
  expect(manager.listRuntimeKeys()).toEqual([]);
  if (globalThis[key] === manager) Reflect.deleteProperty(globalThis, key);
  delete globalThis[probeKey];
});
`,
    "98-mcp-c-prior-failure.test.ts": `${imports}
it("fails MCP cleanup before the runner opens its cleanup scope", async () => {
  const { createAgentCleanupScope } = await import(${source("agents/run-cleanup-timeout.ts")});
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "prior-failure", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const probe = globalThis[probeKey] = { manager, closes: 0 };
  lease.runtime.joinCleanup = async () => {
    probe.closes++;
    throw new Error("Synthetic MCP closure could not be confirmed");
  };
  const scope = createAgentCleanupScope();
  await scope.run(() => manager.disposeAll());
  expect(scope.outcome).toBe("uncertain");
  expect(manager.listRuntimeKeys()).toEqual([]);
  await vi.resetModules();
});
`,
    "98-mcp-d-prior-custody.test.ts": `${imports}
it("retains MCP custody after an earlier disposal failure without retrying it", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
  if (globalThis[key] === probe.manager) Reflect.deleteProperty(globalThis, key);
  delete globalThis[probeKey];
});
`,
    "99-mcp-a-uncertain-owner.test.ts": `${imports}
it("records old-module MCP cleanup uncertainty during file retirement", async () => {
  const manager = await fixtureManager();
  const lease = await manager.acquire({ sessionId: "uncertain", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const probe = globalThis[probeKey] = { manager, closes: 0 };
  lease.runtime.joinCleanup = async () => {
    probe.closes++;
    throw new Error("Synthetic MCP closure could not be confirmed");
  };
  // The runner imports its scope from a new module graph; the manager records
  // the swallowed disposal error through its original cleanup module.
  await vi.resetModules();
});
`,
    "99-mcp-b-retained-owner.test.ts": `${imports}
it("retains the uncertain MCP owner without retrying its failed disposal", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
});
`,
    "99-mcp-c-runner-generation.test.ts": `${imports}
it("keeps uncertain MCP custody after the runner module is reevaluated", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
});
`,
  };
}
