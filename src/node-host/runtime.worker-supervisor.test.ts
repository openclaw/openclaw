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
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
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
    fs.mkdirSync(fixture.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fixture.stateDir, 0o700);
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
      platform: "linux",
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
    runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));

    try {
      await capacityReady.promise;
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 2 },
      ]);
      const launching = runtime.invoke({
        id: "invoke-launch",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify(input),
      });
      // The journal becomes running before startup settles. Hold the completed
      // launch response so cancellation exercises the admitted worker's lifetime.
      await launchResponseEntered.promise;
      expect((await store.get(input.launchId))?.state).toBe("running");

      runtime.cancel("invoke-launch");
      await runtime.cancelAll();
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

  it("keeps the original supervisor failure in the raw node log, not tails or console", async () => {
    const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-runtime-log-"));
    const logFile = path.join(fixture.root, "node.log");
    const secret = "sk-abcdefghijklmnopqrstuv";
    const marker = "TEST_NODE_WORKER_SUPERVISOR_FAILURE";
    const consoleWarn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn: consoleWarn, error: vi.fn() };
    setLoggerOverride({ level: "info", consoleLevel: "warn", file: logFile });
    const responses: Array<{ method: string; params: unknown }> = [];
    const request: NodeHostClient["request"] = async <T = Record<string, unknown>>(
      method: string,
      params?: unknown,
    ): Promise<T> => {
      responses.push({ method, params });
      return {} as T;
    };
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true, capacity: 1 } },
      },
      env: { ...fixture.env, PATH: process.env.PATH },
    });
    expect(prepared.workerHostingEnabled, prepared.workerHostingDisabledReason).toBe(true);
    const runtime = prepared.start({ client: { request } });
    let armed = false;
    // oxlint-disable-next-line typescript/unbound-method -- call below preserves the intercepted worker as receiver.
    const execute = NodeWorkerJournalWorker.prototype.execute;
    const spy = vi.spyOn(NodeWorkerJournalWorker.prototype, "execute").mockImplementation(function (
      this: NodeWorkerJournalWorker,
      command,
      authority,
    ) {
      if (armed && command.type === "nodeWorker.turn.get") {
        armed = false;
        return Promise.reject(new Error(`${marker} Authorization: Bearer ${secret}`));
      }
      return execute.call(this, command, authority);
    });

    try {
      armed = true;
      await runtime.invoke({
        id: "invoke-status",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        paramsJSON: JSON.stringify({ launchId: "launch-missing" }),
      });
      expect(armed).toBe(false);
      const result = responses.find(({ method }) => method === "node.invoke.result")?.params;
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "node worker supervisor command failed" },
      });

      // The rejection fails one command; the same runtime keeps answering later requests.
      await runtime.invoke({
        id: "invoke-status-after",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        paramsJSON: JSON.stringify({ launchId: "launch-missing" }),
      });
      const after = responses.find(
        ({ method, params }) =>
          method === "node.invoke.result" &&
          (params as { id?: string } | undefined)?.id === "invoke-status-after",
      )?.params;
      expect(after).toMatchObject({ ok: true, payloadJSON: "null" });

      await flushLogger();
      const raw = fs.readFileSync(logFile, "utf8");
      expect(raw).toContain(marker);
      expect(raw).toContain(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
      expect(raw).toContain(secret);
      const tail = (await readConfiguredLogTail()).lines.join("\n");
      expect(tail).toContain(marker);
      expect(tail).not.toContain(secret);
      expect(consoleWarn).toHaveBeenCalled();
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(secret);
    } finally {
      spy.mockRestore();
      try {
        await runtime.close();
        await flushLogger();
      } finally {
        resetLogger();
        setLoggerOverride(null);
        loggingState.rawConsole = null;
      }
    }
  });
});
