import fs from "node:fs";
import path from "node:path";
import type { TimerOptions } from "node:timers";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_LINEAGE_START_PROTOCOL_FEATURE,
  WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
  WORKER_NATIVE_PROCESS_OWNER_V2_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
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
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import * as workerProcessIdentity from "./node-worker-process-identity.js";
import { createNodeWorkerLaunchRecovery } from "./node-worker-supervisor-recovery.js";
import {
  createObservedNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testIsolatedWorkerLaunchInput as launchInput,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import * as workerTreeControl from "./node-worker-tree-control.js";

const recoveryClock = vi.hoisted(() => ({
  wait: undefined as ((ms?: number) => Promise<void> | undefined) | undefined,
}));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: (ms?: number, value?: unknown, options?: TimerOptions) =>
      recoveryClock.wait?.(ms)?.then(() => value) ?? actual.setTimeout(ms, value, options),
  };
});

const tempDirs = useStateDatabaseTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  const value = createObservedNodeWorkerSupervisorFixture(
    tempDirs.make("node-worker-startup-"),
    options,
  );
  const { supervisor, env } = value;
  return {
    ...value,
    store: () => new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })),
    launch: (input: ReturnType<typeof launchInput>, signal?: AbortSignal) =>
      supervisor.launch(input, TEST_WORKER_ENDPOINT, signal),
  };
}

function writeWorker(bundleRoot: string, input: ReturnType<typeof launchInput>, source: string) {
  fs.writeFileSync(
    path.join(
      bundleRoot,
      input.gatewayNamespace,
      "bundles",
      input.expectedBundleHash,
      "worker.mjs",
    ),
    source,
  );
}

async function prepareWindowsRecovery(
  f: ReturnType<typeof fixture>,
  cleanupMode: "windows-job" | "process-group",
) {
  const store = f.store();
  const input = launchInput(f.workspaceDir, "windows-recovery", "wait");
  const claim = {
    ...testNodeWorkerLaunchIdentity(input),
    gatewayNamespace: input.gatewayNamespace,
  };
  const supervisor = { pid: 2_000_000_001, startTime: 1 };
  const worker = { pid: 2_000_000_002, startTime: 2 };
  vi.spyOn(workerProcessIdentity, "getNodeWorkerBootIdentity").mockReturnValue("win32:test-boot");
  await store.claim(claim, supervisor, 1);
  const receipt = await store.markRunning({ ...claim, supervisor, worker, cleanupMode });
  const inspect = workerProcessIdentity.inspectNodeWorkerProcessIdentity;
  const observation: { workerState: "live" | "dead" | "reused" } = { workerState: "live" };
  vi.spyOn(workerProcessIdentity, "inspectNodeWorkerProcessIdentity").mockImplementation(
    (identity) =>
      identity.pid === supervisor.pid
        ? "dead"
        : identity.pid === worker.pid
          ? observation.workerState
          : inspect(identity),
  );
  return { store, input, receipt, worker, observation };
}

describe("node worker startup", () => {
  it.runIf(process.platform === "linux" || process.platform === "darwin").each([
    { build: "native-v1", lineage: true, nativeOwner: "v1" },
    { build: "native-v2", lineage: true, nativeOwner: "v2" },
    { build: "lineage-only", lineage: true, nativeOwner: "none" },
    { build: "released", lineage: false, nativeOwner: "none" },
    { build: "native-v2-without-lineage", lineage: false, nativeOwner: "v2" },
  ])(
    "preserves the $build worker's start envelope and process group",
    async ({ build, lineage, nativeOwner }) => {
      await using f = fixture();
      const { bundleRoot, workspaceDir } = f;
      const input = launchInput(workspaceDir, `start-contract-${build}`);
      input.descriptor.admission.handshake.openclawVersion =
        nativeOwner === "v2" ? "2026.10.7" : "2026.9.4";
      input.descriptor.admission.handshake.protocolFeatures =
        input.descriptor.admission.handshake.protocolFeatures.filter(
          (feature) =>
            (feature !== WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE || nativeOwner === "v1") &&
            (feature !== WORKER_NATIVE_PROCESS_OWNER_V2_PROTOCOL_FEATURE || nativeOwner === "v2") &&
            (lineage ||
              (feature !== WORKER_LINEAGE_START_PROTOCOL_FEATURE &&
                feature !== WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE)),
        );
      const native =
        lineage && (nativeOwner === "v2" || (process.platform === "linux" && nativeOwner === "v1"));
      const expectedKeys = [
        ...(lineage ? ["lineageFds"] : []),
        ...(native ? ["nativeProcessOwner"] : []),
        "type",
      ];
      const reportPath = f.file("start-contract.json");
      writeWorker(
        bundleRoot,
        input,
        `import { spawnSync } from "node:child_process";
process.once("message", message => {
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
});
${TEST_WORKER_SOURCE}`,
      );
      let adapterPid: number | undefined;
      observeNodeWorkerAdapters((adapter) => {
        adapterPid = adapter.pid;
      });
      await f.launch(input);
      expect(await f.terminal(input.launchId)).toMatchObject({ state: "completed" });
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        pid: number;
        pgid: number;
        keys: string[];
      };
      expect(report).toMatchObject({ keys: expectedKeys, pgid: adapterPid });
      if (lineage) {
        expect(report.pid).not.toBe(adapterPid);
      } else {
        expect(report.pid).toBe(adapterPid);
      }
    },
  );

  it("does not open or signal a child after markRunning observes its terminal receipt", async () => {
    await using f = fixture({ capacity: 1 });
    const { supervisor, workspaceDir, capacities } = f;
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    let opened: MockInstance | undefined;
    let signalled: MockInstance | undefined;
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let cleanupSettled = false;
    let adapter: NodeWorkerChildAdapter | undefined;
    observeNodeWorkerAdapters((child) => {
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
      opened = vi.spyOn(child, "openStartGate");
      signalled = vi.spyOn(child, "kill");
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

    expect(await f.launch(input)).toMatchObject({ state: "completed" });
    // Capacity returns only after the real child exit and adapter settlement.
    await vi.waitFor(() => expect(capacities.at(-1)).toEqual({ total: 1, available: 1 }), {
      timeout: 5_000,
    });
    expect(childExit).toEqual({ code: 0, signal: null });
    expect([cleanupSettled, adapter?.stdin?.destroyed]).toEqual([true, true]);
    expect(opened).not.toHaveBeenCalled();
    expect(fs.existsSync(f.file("fast-terminal-marker"))).toBe(false);
    expect((await f.receipt(input.launchId))?.state).toBe("completed");
    await supervisor.close();
    expect(signalled).not.toHaveBeenCalled();
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
      await using f = fixture();
      const { bundleRoot, supervisor, workspaceDir } = f;
      const input = launchInput(workspaceDir, "prestart-exit-launch");
      const exitedPath = f.file("prestart-exited");
      writeWorker(
        bundleRoot,
        input,
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
        await f.launch(input, controller.signal);
        const terminal = await f.terminal(input.launchId);

        expect(fs.existsSync(exitedPath)).toBe(true);
        expect(childExit).toEqual({ code: 23, signal: null });
        for (const receipt of [terminal, await f.receipt(input.launchId)]) {
          expect(receipt).toMatchObject({ state, errorText });
        }
      } finally {
        captureAdapter.mockRestore();
        observationReleased.resolve();
        await closing;
      }
    },
  );

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s during startup closes the gate before worker code runs",
    async (operation, state) => {
      await using f = fixture();
      const { supervisor, workspaceDir } = f;
      const input = launchInput(workspaceDir, `${operation}-startup-launch`, "tree");
      // oxlint-disable-next-line typescript/unbound-method -- called with the original store.
      const originalMarkRunning = NodeWorkerLaunchStore.prototype.markRunning;
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

      await f.launch(input);
      await stopping;

      expect((await supervisor.status(input.launchId))?.state).toBe(state);
      expect(fs.existsSync(f.file("grandchild.pid"))).toBe(false);
    },
  );
});

describe("node worker supervisor initialization", () => {
  it.each(["dead", "reused"] as const)(
    "holds Windows capacity until the recorded worker is %s and the Job grace expires",
    async (gone) => {
      await using f = fixture();
      const { store, input, receipt, worker, observation } = await prepareWindowsRecovery(
        f,
        "windows-job",
      );
      const poll = createDeferred();
      const grace = createDeferred();
      const exited = createDeferred();
      const graceExpired = createDeferred();
      const capacities: Array<{ total: number; available: number }> = [];
      const capacity = new NodeWorkerCapacity(store, {
        capacity: 1,
        onCapacityChanged: (value) => capacities.push(value),
      });
      await capacity.initialize(async () => {});
      capacities.length = 0;
      let active = true;
      const recover = createNodeWorkerLaunchRecovery({
        store,
        capacity,
        recoveries: new Map(),
        isRecoveryActive: () => active,
      });
      recoveryClock.wait = (ms) => {
        if (ms === 25) {
          poll.resolve();
          return exited.promise;
        }
        if (ms === 1_000) {
          grace.resolve();
          return graceExpired.promise;
        }
        return undefined;
      };
      const recovering = recover(receipt, true, undefined, true);
      try {
        await awaitGateBeforeSettlement(poll.promise, recovering, "released a live Windows worker");
        expect((await store.get(input.launchId))?.state).toBe("running");
        expect(await store.nonterminalCount()).toBe(1);
        expect(capacities).toEqual([]);
        observation.workerState = gone;
        exited.resolve();
        await awaitGateBeforeSettlement(grace.promise, recovering, "skipped Windows Job grace");
        expect((await store.get(input.launchId))?.state).toBe("running");
        expect(capacities).toEqual([]);
        graceExpired.resolve();
        expect(await recovering).toMatchObject({ state: "interrupted", worker });
        expect(await store.nonterminalCount()).toBe(0);
        expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
      } finally {
        active = false;
        recoveryClock.wait = undefined;
        exited.resolve();
        graceExpired.resolve();
        await recovering;
      }
    },
  );

  it("keeps the additive table absent until the first stateful operation", async () => {
    await using f = fixture();
    const { bundleRoot, env, supervisor } = f;
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

  it("keeps older Windows receipts reserved without recorded Job custody", async () => {
    await using f = fixture();
    const { bundleRoot, env } = f;
    const { store, input, worker, observation } = await prepareWindowsRecovery(f, "process-group");
    observation.workerState = "reused";
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
      expect(await store.get(input.launchId)).toMatchObject({
        state: "running",
        worker,
        workerCleanupMode: "process-group",
      });
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(await recovered.hasActiveWork()).toBe(true);
      expect(signal).not.toHaveBeenCalled();
    } finally {
      await recovered.close();
    }
  });
});

it.skipIf(process.platform === "win32").for(["uncertain", "confirmed"] as const)(
  "settles durable capacity from the native cleanup certificate (%s)",
  { timeout: 20_000 },
  async (cleanupStatus, { signal }) => {
    await using f = fixture({ capacity: 1 });
    const { supervisor, workspaceDir, capacities } = f;
    const input = testWorkerLaunchInput(workspaceDir, "uncertain-owner");
    const store = f.store();
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
      await f.launch(input);
      await withinTest(reported.promise, signal);
      const confirmed = cleanupStatus === "confirmed";
      const stopping = supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
      if (confirmed) {
        await stopping;
      } else {
        await expect(stopping).rejects.toThrow("cleanup remains unconfirmed");
      }
      expect((await store.get(input.launchId))?.state).toBe(confirmed ? "completed" : "running");
      expect(capacities.at(-1)).toEqual({ total: 1, available: Number(confirmed) });
      expect(await supervisor.hasActiveWork()).toBe(!confirmed);
      if (confirmed) {
        return;
      }

      const replacement = testWorkerLaunchInput(workspaceDir, "replacement-owner");
      replacement.descriptor.admission.environmentId = "replacement-environment";
      replacement.descriptor.admission.sessionId = "replacement-session";
      let clock: MockInstance<typeof performance.now> | undefined;
      const capacityClaim = vi.spyOn(NodeWorkerLaunchStore.prototype, "claim");
      try {
        const launching = supervisor.launch(replacement, TEST_WORKER_ENDPOINT);
        await vi.waitFor(async () => {
          const results = await Promise.all(
            capacityClaim.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
          );
          expect(results.some((result) => result.action === "at-capacity")).toBe(true);
        });
        // Expire the real policy only after the worker proves the slot remains reserved.
        // Timers and database/process lifecycle keep their native behavior.
        clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_000);
        await expect(launching).rejects.toMatchObject({
          code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
          message: "node worker capacity remained full for 10000 ms",
        });
      } finally {
        clock?.mockRestore();
        capacityClaim.mockRestore();
      }
    } finally {
      capture.mockRestore();
      restoreConfirmation?.();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps physical capacity reserved after a committed turn reply becomes unknown",
  async ({ signal }) => {
    const f = fixture({
      capacity: 1,
    });
    const { env, supervisor, workspaceDir, capacities } = f;
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
      await f.launch(input);
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
        JSON.parse(fs.readFileSync(f.file(`${input.launchId}.started.json`), "utf8")),
      ).toMatchObject({ starts: 1 });
    } finally {
      replies.mockRestore();
      requests.mockRestore();
      await Promise.allSettled([supervisor.close(), reader.drain()]);
    }
  },
  20_000,
);
