import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../infra/node-commands.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { NodeHostClient } from "./client.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: vi.fn(() => false),
  isRegisteredNodeHostCommandDuplex: vi.fn(() => false),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [],
  })),
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("node-host runtime worker supervisor lifetime", () => {
  it("keeps a claimed worker alive across invoke cancel and reconnect until runtime close", async () => {
    const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-runtime-"));
    fs.mkdirSync(fixture.stateDir, { recursive: true });
    fs.renameSync(fixture.bundleRoot, path.join(fixture.stateDir, "node-host"));
    const input = testWorkerLaunchInput(fixture.workspaceDir, "launch-runtime", "wait");
    const launchResponseEntered = createDeferred();
    const launchResponseHeld = createDeferred();
    const responses: Array<{ method: string; params: unknown }> = [];
    const request: NodeHostClient["request"] = async <T = Record<string, unknown>>(
      method: string,
      params?: unknown,
    ): Promise<T> => {
      responses.push({ method, params });
      if (
        method === "node.invoke.result" &&
        (params as { id?: string } | undefined)?.id === "invoke-launch"
      ) {
        launchResponseEntered.resolve();
        await launchResponseHeld.promise;
      }
      return {} as T;
    };
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true, capacity: 2 } },
      },
      env: { ...fixture.env, PATH: process.env.PATH },
      enableWorkerRuns: true,
      platform: "linux",
    });
    expect(prepared.manifest.commands).not.toEqual(
      expect.arrayContaining([...NODE_WORKER_PRIVATE_COMMANDS]),
    );
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const runtime = prepared.start({
      client: { request },
      onRunnerCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    await vi.waitFor(() =>
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 2 },
      ]),
    );
    runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));

    try {
      const launching = runtime.invoke({
        id: "invoke-launch",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify(input),
      });
      // The journal becomes running before startup settles. Hold the completed
      // launch response so cancellation exercises the admitted worker's lifetime.
      await vi.waitFor(() => launchResponseEntered.promise);
      expect((await store.get(input.launchId))?.state).toBe("running");

      runtime.cancel("invoke-launch");
      runtime.cancelAll();
      expect((await store.get(input.launchId))?.state).toBe("running");
      launchResponseHeld.resolve();
      await launching;
      expect(await runtime.tryPauseForUpdate()).toBe(false);

      await runtime.invoke({
        id: "invoke-status",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        paramsJSON: JSON.stringify({ launchId: input.launchId }),
      });
      const status = responses.find(
        ({ method, params }) =>
          method === "node.invoke.result" &&
          (params as { id?: string } | undefined)?.id === "invoke-status",
      )?.params as { payloadJSON?: string } | undefined;
      expect(JSON.parse(status?.payloadJSON ?? "{}")).toMatchObject({
        launchId: input.launchId,
        state: "running",
      });

      await runtime.invoke({
        id: "invoke-replay",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify(input),
      });
      expect((await store.get(input.launchId))?.state).toBe("running");
    } finally {
      launchResponseHeld.resolve();
      await runtime.close();
    }

    expect((await store.get(input.launchId))?.state).toBe("interrupted");
  });
});
