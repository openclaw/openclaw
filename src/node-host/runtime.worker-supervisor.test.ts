import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import * as state from "../state/openclaw-state-db.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { NodeHostClient } from "./client.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as worker from "./node-worker-supervisor.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";

// mock-isolation: worker lifetime proof must not modify the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

// mock-isolation: the supervisor owns real workers here, but no plugin-host services are enabled.
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: vi.fn(() => false),
  isRegisteredNodeHostCommandDuplex: vi.fn(() => false),
  listRegisteredNodeHostCapsAndCommands: () => ({ caps: [], commands: [], nodePluginTools: [] }),
  watchRegisteredNodeHostCommandAvailability: vi.fn(() => () => {}),
  notifyRegisteredNodeHostCommandDisconnect: vi.fn(async () => undefined),
  invokeRegisteredNodeHostCommand: vi.fn(async () => null),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
  resolveNodeHostedSkillDirectory: vi.fn(() => null),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await state.closeOpenClawStateDatabaseAsync();
    state.closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("keeps a claimed worker alive across invoke cancel and reconnect until runtime close", async () => {
  const platform = mockProcessPlatform("linux");
  onTestFinished(() => platform.mockRestore());
  const fixture = worker.writeNodeWorkerFixture(tempDirs.make("node-worker-runtime-"));
  fs.mkdirSync(fixture.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(fixture.stateDir, 0o700);
  fs.renameSync(fixture.bundleRoot, path.join(fixture.stateDir, "node-host"));
  const input = worker.testWorkerLaunchInput(fixture.workspaceDir, "launch-runtime", "wait");
  const launchResponseEntered = createDeferred();
  const launchResponseHeld = createDeferred();
  const responses = new Map<string, { payloadJSON?: string }>();
  const request: NodeHostClient["request"] = async <T>(method: string, params?: unknown) => {
    if (method === "node.invoke.result") {
      const response = params as { id: string; payloadJSON?: string };
      responses.set(response.id, response);
      if (response.id === "invoke-launch") {
        launchResponseEntered.resolve();
        await launchResponseHeld.promise;
      }
    }
    return {} as T;
  };
  const prepared = await prepareNodeHostRuntime({
    config: {
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true, capacity: 2 } },
    },
    env: { ...fixture.env, PATH: process.env.PATH },
  });
  expect(prepared.workerHostingEnabled, prepared.workerHostingDisabledReason).toBe(true);
  for (const command of NODE_WORKER_PRIVATE_COMMANDS) {
    expect(prepared.manifest.commands, command).not.toContain(command);
  }
  const capacitySnapshots: Array<{ total: number; available: number }> = [];
  const capacityReady = createDeferred();
  const runtime = prepared.start({
    client: { request },
    onRunnerCapacityChanged: (capacity) => {
      capacitySnapshots.push(capacity);
      if (capacity.available === 2) {
        capacityReady.resolve();
      }
    },
  });
  const invoke = (id: string, command: string, params: unknown) =>
    runtime.invoke({ id, nodeId: "node-1", command, paramsJSON: JSON.stringify(params) });
  runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
  const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));

  try {
    await capacityReady.promise;
    expect(capacitySnapshots).toEqual([0, 2].map((available) => ({ total: 2, available })));
    const launching = invoke("invoke-launch", "worker.launch.v1", input);
    // Hold the completed launch response so cancellation exercises the admitted worker's lifetime.
    await launchResponseEntered.promise;
    expect((await store.get(input.launchId))?.state).toBe("running");

    runtime.cancel("invoke-launch");
    await runtime.cancelAll();
    expect((await store.get(input.launchId))?.state).toBe("running");
    launchResponseHeld.resolve();
    await launching;
    expect(await runtime.tryPauseForUpdate()).toBe(false);

    await invoke("invoke-status", "worker.status.v1", { launchId: input.launchId });
    const status = responses.get("invoke-status");
    expect(JSON.parse(status?.payloadJSON ?? "{}")).toMatchObject({
      launchId: input.launchId,
      state: "running",
    });

    await invoke("invoke-replay", "worker.launch.v1", input);
    expect((await store.get(input.launchId))?.state).toBe("running");
  } finally {
    launchResponseHeld.resolve();
    await runtime.close();
  }

  expect((await store.get(input.launchId))?.state).toBe("interrupted");
});
