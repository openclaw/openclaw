import fs from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_LINEAGE_START_PROTOCOL_FEATURE,
  WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import type {
  SqliteWorkerCommand,
  SqliteWorkerReply,
  SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import * as workerProcessIdentity from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import * as workerTreeControl from "./node-worker-tree-control.js";

const tempDirs = useStateDatabaseTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-startup-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

describe("node worker startup", () => {
  it.runIf(process.platform === "linux" || process.platform === "darwin").each([
    { build: "lineage-only", lineage: true },
    { build: "released", lineage: false },
  ])(
    "preserves the $build worker's start envelope and process group",
    async ({ build, lineage }) => {
      const { bundleRoot, supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `start-contract-${build}`);
      input.descriptor.admission.handshake.openclawVersion = "2026.9.4";
      input.descriptor.admission.handshake.protocolFeatures =
        input.descriptor.admission.handshake.protocolFeatures.filter(
          (feature) => feature !== WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
        );
      if (!lineage) {
        input.descriptor.admission.handshake.protocolFeatures =
          input.descriptor.admission.handshake.protocolFeatures.filter(
            (feature) =>
              feature !== WORKER_LINEAGE_START_PROTOCOL_FEATURE &&
              feature !== WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
          );
      }
      const expectedKeys = lineage ? ["lineageFds", "type"] : ["type"];
      const reportPath = path.join(workspaceDir, "start-contract.json");
      fs.writeFileSync(
        path.join(
          bundleRoot,
          input.gatewayNamespace,
          "bundles",
          input.expectedBundleHash,
          "worker.mjs",
        ),
        `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const started = new Promise(resolve => process.once("message", message => {
  const keys = Object.keys(message).sort();
  const expected = ${JSON.stringify(expectedKeys)};
  if (message.type !== "openclaw-worker-start-v1" || JSON.stringify(keys) !== JSON.stringify(expected)) {
    process.stderr.write("unsupported start envelope");
    process.exit(24);
  }
  if (${lineage}) for (const fd of message.lineageFds) fs.fstatSync(fd);
  const group = spawnSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" });
  if (group.status !== 0) process.exit(25);
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ pid: process.pid, pgid: Number(group.stdout.trim()), keys }));
  resolve();
}));
await started;
const lines = createInterface({ input: process.stdin });
lines.once("line", line => {
  const turn = JSON.parse(line);
  fs.writeSync(1, JSON.stringify({ type: "result", turnId: turn.turnId, retainWorker: false,
    result: { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 } }) + "\\n");
  process.exit(0);
});`,
      );
      let adapterPid: number | undefined;
      const captureAdapter = observeNodeWorkerAdapters((adapter) => {
        adapterPid = adapter.pid;
      });
      try {
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        expect(await waitForTerminal(supervisor, input.launchId)).toMatchObject({
          state: "completed",
        });
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
          pid: number;
          pgid: number;
          keys: string[];
        };
        expect(report.keys).toEqual(expectedKeys);
        expect(report.pgid).toBe(adapterPid);
        if (lineage) {
          expect(report.pid).not.toBe(adapterPid);
        } else {
          expect(report.pid).toBe(adapterPid);
        }
      } finally {
        captureAdapter.mockRestore();
        await supervisor.close();
      }
    },
  );

  it("does not open or signal a child after markRunning observes its terminal receipt", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { supervisor, workspaceDir, env } = fixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    const opened = vi.fn();
    const signalled = vi.fn();
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let cleanupSettled = false;
    let adapter: NodeWorkerChildAdapter | undefined;
    const captureAdapter = observeNodeWorkerAdapters((child) => {
      adapter = child;
      child.onExit((code, signal) => {
        childExit = { code, signal };
      });
      const cleanup = child.waitForExtinction?.() ?? child.wait().then(() => undefined);
      void cleanup.then(
        () => {
          cleanupSettled = true;
        },
        () => undefined,
      );
      const openStartGate = child.openStartGate!;
      vi.spyOn(child, "openStartGate").mockImplementation(() => {
        opened();
        return openStartGate();
      });
      const kill = child.kill;
      vi.spyOn(child, "kill").mockImplementation((signal) => {
        signalled(signal);
        kill(signal);
      });
    });
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(async function (
      this: NodeWorkerLaunchStore,
      params,
    ) {
      expect(adapter?.pid).toBe(params.worker.pid);
      return await this.finish({
        launchId: params.launchId,
        planHash: params.planHash,
        supervisor: params.supervisor,
        worker: null,
        state: "completed",
        resultJson: '{"status":"completed"}',
      });
    });

    try {
      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "completed",
      });
      // Capacity returns only after the real child exit and adapter settlement.
      await vi.waitFor(() => expect(capacities.at(-1)).toEqual({ total: 1, available: 1 }), {
        timeout: 5_000,
      });
      expect(childExit).toEqual({ code: 0, signal: null });
      expect(cleanupSettled).toBe(true);
      expect(adapter?.stdin?.destroyed).toBe(true);
      expect(opened).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspaceDir, "fast-terminal-marker"))).toBe(false);
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("completed");
      await supervisor.close();
      expect(signalled).not.toHaveBeenCalled();
    } finally {
      captureAdapter.mockRestore();
      await supervisor.close();
    }
  });

  it.each([
    { operation: "none", state: "failed", errorText: "node worker failed with exit code 23" },
    { operation: "cancel", state: "cancelled", errorText: "node worker launch cancelled" },
    {
      operation: "close",
      state: "interrupted",
      errorText: "node worker launch interrupted during node-host shutdown",
    },
  ] as const)(
    "records $state when a child exits before descriptor delivery ($operation)",
    async ({ operation, state, errorText }) => {
      const { bundleRoot, supervisor, workspaceDir, env } = fixture();
      const input = launchInput(workspaceDir, "prestart-exit-launch");
      const exitedPath = path.join(workspaceDir, "prestart-exited");
      fs.writeFileSync(
        path.join(
          bundleRoot,
          input.gatewayNamespace,
          "bundles",
          input.expectedBundleHash,
          "worker.mjs",
        ),
        `import fs from "node:fs"; process.once("message", () => { fs.writeFileSync(${JSON.stringify(exitedPath)}, "exited"); process.exit(23); });`,
      );
      const observationReleased = createDeferred();
      const controller = new AbortController();
      let closing: Promise<void> | undefined;
      let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const captureAdapter = observeNodeWorkerAdapters((adapter) => {
        // Let the supervisor subscribe before wait can claim stdout for discarding.
        const wait = adapter.wait;
        const openStartGate = adapter.openStartGate!;
        const kill = adapter.kill;
        // Reach the closed real pipe before its exit can settle the launch journal.
        vi.spyOn(adapter, "openStartGate").mockImplementation(async () => {
          await openStartGate();
          childExit = await wait();
          if (operation === "cancel") {
            controller.abort(new Error("cancel during startup"));
          } else if (operation === "close") {
            closing = supervisor.close();
          }
        });
        vi.spyOn(adapter, "wait").mockImplementation(async () => {
          const exit = await wait();
          await observationReleased.promise;
          return exit;
        });
        vi.spyOn(adapter, "kill").mockImplementation((signal) => {
          kill(signal);
          observationReleased.resolve();
        });
      });

      try {
        await supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal);
        const terminal = await waitForTerminal(supervisor, input.launchId);

        expect(fs.existsSync(exitedPath)).toBe(true);
        expect(childExit).toEqual({ code: 23, signal: null });
        expect(terminal).toMatchObject({ state, errorText });
        expect(
          await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
        ).toMatchObject({
          state,
          errorText,
        });
      } finally {
        captureAdapter.mockRestore();
        observationReleased.resolve();
        await closing;
        await supervisor.close();
      }
    },
  );

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s during startup closes the gate before worker code runs",
    async (operation, state) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `${operation}-startup-launch`, "tree");
      const originalMarkRunning = Object.getOwnPropertyDescriptor(
        NodeWorkerLaunchStore.prototype,
        "markRunning",
      )?.value as NodeWorkerLaunchStore["markRunning"];
      let stopping: Promise<unknown> | undefined;
      vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(async function (
        this: NodeWorkerLaunchStore,
        params,
      ) {
        const receipt = await originalMarkRunning.call(this, params);
        stopping =
          operation === "cancel"
            ? supervisor.cancel(testNodeWorkerLaunchIdentity(input))
            : supervisor.close();
        return receipt;
      });

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await stopping;

      expect((await supervisor.status(input.launchId))?.state).toBe(state);
      expect(fs.existsSync(path.join(workspaceDir, "grandchild.pid"))).toBe(false);
      await supervisor.close();
    },
  );
});

describe("node worker supervisor initialization", () => {
  it("keeps the additive table absent until the first stateful operation", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    const database = openOpenClawStateDatabase({ env });
    const findTable = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launches");

    expect(findTable()).toBeUndefined();
    await supervisor.close();
    expect(findTable()).toBeUndefined();

    const active = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it.each(["reused"] as const)(
    "retains Windows restart capacity when the recorded worker root is %s",
    async (rootState) => {
      const { bundleRoot, env, supervisor, workspaceDir } = fixture();
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      const input = launchInput(workspaceDir, `windows-${rootState}`, "wait");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      const previousSupervisor = { pid: 2_000_000_001, startTime: 1 };
      const worker = { pid: 2_000_000_002, startTime: 2 };
      await store.claim(claim, previousSupervisor, 1);
      await store.markRunning({
        ...claim,
        supervisor: previousSupervisor,
        worker,
        cleanupMode: "process-group",
      });

      const inspectIdentity = workerProcessIdentity.inspectNodeWorkerProcessIdentity;
      vi.spyOn(workerProcessIdentity, "inspectNodeWorkerProcessIdentity").mockImplementation(
        (identity) => {
          if (identity.pid === previousSupervisor.pid) {
            return "dead";
          }
          return identity.pid === worker.pid ? rootState : inspectIdentity(identity);
        },
      );
      const inspectTree = workerTreeControl.inspectOwnedNodeWorkerTree;
      vi.spyOn(workerTreeControl, "inspectOwnedNodeWorkerTree").mockImplementation((identity) => {
        // Scope the Windows observation to its owner; the real database remains host-native.
        const platform = mockProcessPlatform("win32");
        try {
          return inspectTree(identity);
        } finally {
          platform.mockRestore();
        }
      });
      const signal = vi.spyOn(workerTreeControl, "signalOwnedNodeWorkerTree").mockResolvedValue();
      const capacities: Array<{ total: number; available: number }> = [];
      const recovered = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: 1,
        onCapacityChanged: (value) => capacities.push(value),
      });
      try {
        await recovered.initialize();
        expect(await store.get(input.launchId)).toMatchObject({ state: "running", worker });
        expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
        expect(await recovered.hasActiveWork()).toBe(true);
        expect(signal).not.toHaveBeenCalled();
      } finally {
        await recovered.close();
        await supervisor.close();
      }
    },
  );
});

it.skipIf(process.platform === "win32").for(["uncertain", "confirmed"] as const)(
  "settles durable capacity from the native cleanup certificate (%s)",
  { timeout: 20_000 },
  async (cleanupStatus, { signal }) => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(
      tempDirs.make("node-worker-uncertain-cleanup-"),
      { capacity: 1, capacityWaitMs: 0, onCapacityChanged: (value) => capacities.push(value) },
    );
    const input = testWorkerLaunchInput(workspaceDir, "uncertain-owner");
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    const reported = createDeferred();
    vi.spyOn(workerTreeControl, "inspectOwnedNodeWorkerTree").mockReturnValue("unknown");
    let restoreConfirmation: (() => void) | undefined;
    const capture = observeNodeWorkerAdapters((adapter) => {
      const waitForExtinction = adapter.waitForExtinction;
      if (!waitForExtinction) {
        throw new Error("Expected the real relay's extinction boundary");
      }
      const confirmExtinction = adapter.confirmExtinction;
      adapter.confirmExtinction = undefined;
      restoreConfirmation = () => {
        adapter.confirmExtinction = confirmExtinction;
      };
      adapter.waitForExtinction = async () => {
        await waitForExtinction();
        reported.resolve();
        return cleanupStatus === "uncertain"
          ? { status: "uncertain", reason: "job-unavailable" }
          : { status: "confirmed" };
      };
    });
    try {
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await withinTest(reported.promise, signal);
      if (cleanupStatus === "confirmed") {
        await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
        expect((await store.get(input.launchId))?.state).toBe("completed");
        expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
        expect(await supervisor.hasActiveWork()).toBe(false);
        return;
      }
      await expect(
        supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input)),
      ).rejects.toThrow("cleanup remains unconfirmed");
      expect((await store.get(input.launchId))?.state).toBe("running");
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(await supervisor.hasActiveWork()).toBe(true);

      const replacement = testWorkerLaunchInput(workspaceDir, "replacement-owner");
      replacement.descriptor.admission.environmentId = "replacement-environment";
      replacement.descriptor.admission.sessionId = "replacement-session";
      await expect(supervisor.launch(replacement, TEST_WORKER_ENDPOINT)).rejects.toMatchObject({
        code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      });
    } finally {
      capture.mockRestore();
      restoreConfirmation?.();
      await supervisor.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps physical capacity reserved after a committed turn reply becomes unknown",
  async ({ signal }) => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(
      tempDirs.make("node-worker-unknown-turn-"),
      { capacity: 1, capacityWaitMs: 0, onCapacityChanged: (value) => capacities.push(value) },
    );
    const input = testWorkerLaunchInput(workspaceDir, "unknown-turn");
    const committed = createDeferred<unknown>();
    let target: { worker: Worker; id: number } | undefined;
    let turnWrites = 0;
    // oxlint-disable-next-line typescript/unbound-method -- call preserves the sending worker.
    const postMessage = Worker.prototype.postMessage;
    const requests = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command = deserialize(
          request.input,
        ) as SqliteWorkerCommand<OpenClawStateWorkerOperations>;
        if (
          command.type === "nodeWorker.turn.finish" &&
          command.input[0].expected.launchId === input.launchId
        ) {
          turnWrites += 1;
          target ??= { worker: this, id: request.id };
        }
      }
      return postMessage.call(this, request, transferList);
    });
    // oxlint-disable-next-line typescript/unbound-method -- call preserves the receiving worker.
    const emit = Worker.prototype.emit;
    const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "message" && target?.worker === this) {
        const reply = args[0] as SqliteWorkerReply;
        if (reply.id === target.id && reply.ok) {
          replies.mockRestore();
          committed.resolve(deserialize(reply.value));
          return emit.call(this, event, { ...reply, value: new Uint8Array([0]) });
        }
      }
      return emit.call(this, event, ...args);
    });
    const reader = new NodeWorkerJournalWorker({ env });
    try {
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      expect(await withinTest(committed.promise, signal)).toMatchObject({
        launchId: input.launchId,
        state: "completed",
      });

      await expect(supervisor.close()).rejects.toThrow();
      await expect(supervisor.status(input.launchId)).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      await expect(supervisor.cancel(testNodeWorkerLaunchIdentity(input))).rejects.toMatchObject({
        code: "outcome-unknown",
      });

      const turn = await reader.execute({ type: "nodeWorker.turn.get", input: [input.launchId] });
      expect(turn).toMatchObject({
        launchId: input.launchId,
        ownerLaunchId: input.launchId,
        state: "completed",
        errorText: null,
      });
      expect(JSON.parse(turn!.resultJson!)).toEqual({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      });
      expect(
        await reader.execute({ type: "nodeWorker.launch.get", input: [input.launchId] }),
      ).toMatchObject({ state: "running", completedAtMs: null });
      expect(await reader.execute({ type: "nodeWorker.launch.nonterminalCount", input: [] })).toBe(
        1,
      );
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(turnWrites).toBe(1);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${input.launchId}.started.json`), "utf8"),
        ),
      ).toMatchObject({ starts: 1 });
    } finally {
      replies.mockRestore();
      requests.mockRestore();
      await Promise.allSettled([supervisor.close(), reader.drain()]);
    }
  },
  20_000,
);
