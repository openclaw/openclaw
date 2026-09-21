import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import * as spawnPs from "../infra/spawn-ps.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerLaunchRecovery } from "./node-worker-supervisor-recovery.js";
import {
  holdNodeWorkerReadiness,
  waitForChildExit,
  waitForChildLine,
  waitForIdentityDeath,
  spawnSupervisorOwner,
  spawnPendingSupervisorOwner,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { inspectOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceProcesses } from "./node-worker-workspace-processes.js";

const spawned = new Set<ChildProcess>();
const ownedProcessGroups: NodeWorkerProcessIdentity[] = [];

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    if (process.platform !== "win32") {
      for (const identity of ownedProcessGroups) {
        if (inspectNodeWorkerProcessIdentity(identity) === "reused") {
          continue;
        }
        try {
          process.kill(-identity.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
    }
    spawned.clear();
    ownedProcessGroups.length = 0;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function fixture(label: string) {
  return writeNodeWorkerFixture(tempDirs.make(label));
}

async function insertLaunch(params: {
  env: NodeJS.ProcessEnv;
  input: ReturnType<typeof testWorkerLaunchInput>;
  state: "pending" | "running";
  supervisor: NodeWorkerProcessIdentity;
  worker?: NodeWorkerProcessIdentity;
  turn?: true;
}) {
  const database = openOpenClawStateDatabase({ env: params.env }).db;
  const state = params.turn ? "pending" : params.state;
  database
    .prepare(
      `INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1)`,
    )
    .run(
      params.input.launchId,
      testNodeWorkerLaunchIdentity(params.input).planHash,
      params.input.gatewayNamespace,
      params.input.descriptor.admission.environmentId,
      params.input.descriptor.admission.sessionId,
      params.input.descriptor.admission.ownerEpoch,
      params.input.placementGeneration,
      params.input.descriptor.assignment.runId,
      state,
      params.supervisor.pid,
      params.supervisor.startTime,
      state === "running" ? (params.worker?.pid ?? null) : null,
      state === "running" ? (params.worker?.startTime ?? null) : null,
    );
  if (params.turn) {
    const journal = new NodeWorkerJournalWorker({ env: params.env });
    await new NodeWorkerTurnStore(journal).claim({
      claim: {
        ...testNodeWorkerLaunchIdentity(params.input),
        gatewayNamespace: params.input.gatewayNamespace,
      },
      ownerLaunchId: params.input.launchId,
      supervisor: params.supervisor,
    });
    if (params.state === "running") {
      await new NodeWorkerLaunchStore(journal).markRunning({
        launchId: params.input.launchId,
        planHash: testNodeWorkerLaunchIdentity(params.input).planHash,
        supervisor: params.supervisor,
        worker: params.worker!,
        cleanupMode: "process-group",
      });
      database
        .prepare("DELETE FROM node_worker_launch_cleanup WHERE launch_id = ?")
        .run(params.input.launchId);
    }
  }
}

describe("node worker supervisor recovery", () => {
  it
    .runIf(process.platform === "linux" || process.platform === "darwin")
    .for([
      "close",
      "recover",
      "anchor-lost",
      "initialize",
      "environment-stop",
      "close-after-initialize",
      "cancel-running",
      "owner-replaced",
      "identity-reused",
      "status-completed",
      "cancel-completed",
      "replay-completed",
    ])(
    "%s observes a stopped cleanup anchor with unreadable argv without releasing its slot",
    async (operation, { signal: testSignal }) => {
      const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-stopped-recovery-");
      const retainsCompletedTurn = operation.endsWith("-completed");
      const input = testWorkerLaunchInput(
        workspaceDir,
        "stopped-former-owner",
        retainsCompletedTurn ? "background-start" : operation === "anchor-lost" ? "tree" : "wait",
      );
      const previous = spawnSupervisorOwner({ bundleRoot, env, input, root });
      spawned.add(previous);
      const receipt = JSON.parse(await waitForChildLine(previous)) as NodeWorkerLaunchReceipt;
      const anchor = receipt.worker!;
      ownedProcessGroups.push(anchor);
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const totalCapacity = ["initialize", "environment-stop"].includes(operation) ? 2 : 1;
      const capacityReleased = createDeferred();
      const replacement = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: totalCapacity,
        onCapacityChanged: (capacity) => {
          capacitySnapshots.push(capacity);
          if (capacity.available === totalCapacity) {
            capacityReleased.resolve();
          }
        },
      });
      let initialization: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      let initialized = false;
      let closed = false;
      const openSync = fs.openSync;
      const psSync = spawnPs.spawnPsSync;
      const openProbe = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
        if (args[0] === `/proc/${anchor.pid}/cmdline`) {
          throw new Error("process command line unavailable");
        }
        return openSync(...args);
      });
      const psProbe = vi.spyOn(spawnPs, "spawnPsSync").mockImplementation((args, timeout) => {
        if (args.includes(String(anchor.pid)) && args.includes("command=")) {
          throw new Error("process command line unavailable");
        }
        return psSync(args, timeout);
      });
      let bodyFailure: { error: unknown } | undefined;
      await (async () => {
        const journal = new NodeWorkerJournalWorker({ env });
        const turns = new NodeWorkerTurnStore(journal);
        if (retainsCompletedTurn) {
          await vi.waitFor(async () =>
            expect((await turns.get(input.launchId))?.state).toBe("completed"),
          );
        }
        const completed = retainsCompletedTurn ? await turns.get(input.launchId) : undefined;
        if (completed) {
          const observer = createNodeWorkerSupervisor({ bundleRoot, env, capacity: 1 });
          try {
            expect(await observer.status(input.launchId)).toEqual(completed);
            expect(inspectNodeWorkerProcessIdentity(receipt.supervisor)).toBe("live");
            expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
            expect((await new NodeWorkerLaunchStore(journal).get(input.launchId))?.state).toBe(
              "running",
            );
          } finally {
            await observer.close();
          }
        }
        let descendant: NodeWorkerProcessIdentity | undefined;
        if (operation === "anchor-lost") {
          const descendantPath = path.join(workspaceDir, "grandchild.pid");
          await vi.waitFor(() =>
            expect(fs.readFileSync(descendantPath, "utf8")).toMatch(/^[1-9]\d*$/u),
          );
          descendant = requireNodeWorkerProcessIdentity(
            Number(fs.readFileSync(descendantPath, "utf8")),
          );
        }
        process.kill(anchor.pid, "SIGSTOP");
        previous.kill("SIGKILL");
        await waitForChildExit(previous);

        initialization = replacement.initialize().then(() => {
          initialized = true;
        });
        void initialization.catch(() => undefined);
        await vi.waitFor(() =>
          expect(capacitySnapshots.at(-1)).toEqual({ total: totalCapacity, available: 0 }),
        );
        expect(initialized).toBe(false);
        if (
          [
            "initialize",
            "environment-stop",
            "close-after-initialize",
            "cancel-running",
            "owner-replaced",
            "identity-reused",
          ].includes(operation) ||
          completed
        ) {
          await vi.waitFor(() => expect(initialized).toBe(true), { timeout: 5_000 });
          await initialization;
          const store = new NodeWorkerLaunchStore(journal);
          expect(await store.get(input.launchId)).toMatchObject({
            state: "running",
            worker: anchor,
            workerCleanupMode: "owned-anchor",
            workerLineageSettled: false,
          });
          expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
          expect(capacitySnapshots.at(-1)).toEqual({
            total: totalCapacity,
            available: totalCapacity - 1,
          });
          expect(await replacement.hasActiveWork()).toBe(true);

          if (operation === "environment-stop") {
            closing = replacement
              .stopEnvironment(testNodeWorkerEnvironmentIdentity(input))
              .finally(() => {
                closed = true;
              });
            void closing.catch(() => undefined);
            await replacement.status(input.launchId);
            await replacement.status(input.launchId);
            expect(closed).toBe(false);
            await expect(
              replacement.launch(
                testWorkerLaunchInput(workspaceDir, "fenced-during-recovery"),
                TEST_WORKER_ENDPOINT,
              ),
            ).rejects.toThrow("node worker environment is stopping");
            process.kill(anchor.pid, "SIGCONT");
            await closing;
            expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead");
            expect(await store.get(input.launchId)).toMatchObject({
              state: "cancelled",
              workerLineageSettled: true,
            });
            expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 2 });
            expect(await replacement.hasActiveWork()).toBe(false);
            return;
          }
          if (operation === "close-after-initialize") {
            await replacement.close();
            const published = [...capacitySnapshots];
            process.kill(anchor.pid, "SIGCONT");
            await waitForIdentityDeath(anchor);
            expect(await store.get(input.launchId)).toMatchObject({
              state: "running",
              workerLineageSettled: true,
            });
            expect(await replacement.status(input.launchId)).toMatchObject({ state: "running" });
            expect(capacitySnapshots).toEqual(published);
            return;
          }
          if (operation === "owner-replaced" || operation === "identity-reused") {
            const signal = vi.spyOn(process, "kill");
            try {
              const database = openOpenClawStateDatabase({ env }).db;
              const current = requireNodeWorkerProcessIdentity(process.pid);
              if (operation === "owner-replaced") {
                database
                  .prepare(
                    "UPDATE node_worker_launches SET supervisor_pid = ?, supervisor_start_time = ? WHERE launch_id = ?",
                  )
                  .run(current.pid, current.startTime, input.launchId);
              } else {
                database
                  .prepare(
                    "UPDATE node_worker_launches SET worker_start_time = ? WHERE launch_id = ?",
                  )
                  .run(anchor.startTime - 1, input.launchId);
              }
              expect(await replacement.status(input.launchId)).toMatchObject({ state: "running" });
              expect(
                signal.mock.calls.filter(
                  ([pid, requested]) => Math.abs(pid) === anchor.pid && requested !== 0,
                ),
              ).toEqual([]);
              expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
            } finally {
              signal.mockRestore();
            }
            process.kill(anchor.pid, "SIGCONT");
            await waitForIdentityDeath(anchor);
            expect(await store.get(input.launchId)).toMatchObject({
              state: "running",
              workerLineageSettled: false,
            });
            expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
            return;
          }
          if (operation === "initialize") {
            const next = testWorkerLaunchInput(workspaceDir, "free-slot", "wait");
            next.descriptor.admission.environmentId = "free-environment";
            next.descriptor.admission.sessionId = "free-session";
            const running = await replacement.launch(next, TEST_WORKER_ENDPOINT);
            expect(running).toMatchObject({ state: "running" });
            expect(running.worker).not.toEqual(anchor);
            await vi.waitFor(() =>
              expect(
                JSON.parse(
                  fs.readFileSync(path.join(workspaceDir, "free-slot.started.json"), "utf8"),
                ),
              ).toMatchObject({ pid: expect.any(Number), starts: 1 }),
            );
            expect(await store.nonterminalCount()).toBe(2);
            expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 0 });
            expect(await replacement.cancel(testNodeWorkerLaunchIdentity(next))).toMatchObject({
              state: "cancelled",
            });
            await waitForIdentityDeath(running.worker!);
            await vi.waitFor(async () => expect(await store.nonterminalCount()).toBe(1));
          }
          const reconcile = () =>
            operation === "cancel-completed" || operation === "cancel-running"
              ? replacement.cancel(testNodeWorkerLaunchIdentity(input))
              : operation === "replay-completed"
                ? replacement.launch(input, TEST_WORKER_ENDPOINT)
                : replacement.status(input.launchId);
          const [reconciled] = await Promise.all([reconcile(), replacement.status(input.launchId)]);
          expect(reconciled).toMatchObject(completed ?? { state: "running" });
          expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
          expect(capacitySnapshots.at(-1)).toEqual({
            total: totalCapacity,
            available: totalCapacity - 1,
          });

          process.kill(anchor.pid, "SIGCONT");
          await waitForIdentityDeath(anchor);
          // Anchor exit can precede group extinction; recovery publishes capacity after both.
          await racePromiseWithAbortSignal(capacityReleased.promise, testSignal);
          expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead");
          const terminalState = operation === "cancel-running" ? "cancelled" : "interrupted";
          expect(await store.get(input.launchId)).toMatchObject({
            state: terminalState,
            workerLineageSettled: true,
          });
          expect(capacitySnapshots.at(-1)).toEqual({
            total: totalCapacity,
            available: totalCapacity,
          });
          expect(await reconcile()).toMatchObject(
            completed ? { ...completed, workerLineageSettled: true } : { state: terminalState },
          );
          expect(await replacement.hasActiveWork()).toBe(false);
          return;
        }
        if (descendant) {
          process.kill(anchor.pid, "SIGKILL");
          await initialization;
          expect(await new NodeWorkerLaunchStore(journal).get(input.launchId)).toMatchObject({
            state: "running",
            worker: anchor,
            workerCleanupMode: "owned-anchor",
            workerLineageSettled: false,
          });
          expect(inspectOwnedNodeWorkerTree(anchor)).toBe("live");
          expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("live");
          expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
          expect(await replacement.hasActiveWork()).toBe(true);
          return;
        }
        if (operation === "recover") {
          process.kill(anchor.pid, "SIGCONT");
          await initialization;
          await waitForIdentityDeath(anchor);
          // Initialization bounds its wait; the recovery owner releases capacity after cleanup.
          await racePromiseWithAbortSignal(capacityReleased.promise, testSignal);
          expect(await new NodeWorkerLaunchStore(journal).get(input.launchId)).toMatchObject({
            state: "interrupted",
            worker: anchor,
            workerCleanupMode: "owned-anchor",
            workerLineageSettled: true,
          });
          expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead");
          expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
          expect(await replacement.hasActiveWork()).toBe(false);
          return;
        }
        closing = replacement.close().then(() => {
          closed = true;
        });
        void closing.catch(() => undefined);

        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
        expect(initialized).toBe(true);
        expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
        expect(await new NodeWorkerLaunchStore(journal).get(input.launchId)).toMatchObject({
          state: "running",
          worker: anchor,
        });
        expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
        expect(await replacement.hasActiveWork()).toBe(true);
        await expect(replacement.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
          "node worker supervisor is closed",
        );
      })().catch((error: unknown) => {
        bodyFailure = { error };
      });
      openProbe.mockRestore();
      psProbe.mockRestore();
      const resumed = Promise.resolve().then(() => {
        if (inspectNodeWorkerProcessIdentity(anchor) === "live") {
          process.kill(anchor.pid, "SIGCONT");
        }
      });
      const previousExit = resumed
        .catch(() => undefined)
        .then(async () => {
          if (previous.exitCode === null && previous.signalCode === null) {
            previous.kill("SIGTERM");
          }
          await waitForChildExit(previous);
        });
      const errors = (
        await Promise.allSettled([
          resumed,
          previousExit,
          initialization,
          closing,
          Promise.resolve().then(() => replacement.close()),
          resumed.catch(() => undefined).then(() => waitForIdentityDeath(anchor)),
        ])
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) {
        throw new AggregateError(
          bodyFailure ? [bodyFailure.error, ...errors] : errors,
          "node worker recovery fixture cleanup failed",
          { cause: bodyFailure ? bodyFailure.error : errors[0] },
        );
      }
      if (bodyFailure) {
        throw bodyFailure.error;
      }
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "retains capacity when a dead anchor has an empty group but an escaped descendant remains",
    async () => {
      const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-lost-lineage-");
      const input = testWorkerLaunchInput(workspaceDir, "lost-lineage", "escaped-tree");
      const owner = spawnSupervisorOwner({ bundleRoot, env, input, root });
      spawned.add(owner);
      const receipt = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
      const anchor = receipt.worker!;
      ownedProcessGroups.push(anchor);
      const descendantPath = path.join(workspaceDir, "grandchild.pid");
      await vi.waitFor(() =>
        expect(fs.readFileSync(descendantPath, "utf8")).toMatch(/^[1-9]\d*$/u),
      );
      const descendant = requireNodeWorkerProcessIdentity(
        Number(fs.readFileSync(descendantPath, "utf8")),
      );
      ownedProcessGroups.push(descendant);
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const replacement = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: 1,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      try {
        // Freeze the old observer before losing its anchor so it cannot settle this row.
        process.kill(owner.pid!, "SIGSTOP");
        process.kill(-anchor.pid, "SIGKILL");
        owner.kill("SIGKILL");
        await waitForChildExit(owner);
        await vi.waitFor(() => expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead"));
        expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("live");
        expect(() => process.kill(-anchor.pid, 0)).toThrow();

        await replacement.initialize();

        expect(await replacement.status(input.launchId)).toMatchObject({
          state: "running",
          worker: anchor,
          workerCleanupMode: "owned-anchor",
          workerLineageSettled: false,
        });
        expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
        expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("live");
        expect(await replacement.hasActiveWork()).toBe(true);
      } finally {
        await replacement.close();
      }
    },
  );

  it("coalesces failed initialization and retries reconciliation on the next attempt", async () => {
    const { bundleRoot, env } = fixture("node-worker-initialization-retry-");
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 2,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const reconciliation = vi
      .spyOn(NodeWorkerLaunchStore.prototype, "listNonterminal")
      .mockImplementationOnce(async () => {
        throw new Error("temporary launch journal failure");
      });

    try {
      const first = supervisor.initialize();
      const concurrent = supervisor.initialize();

      expect(concurrent).toBe(first);
      await expect(first).rejects.toThrow("temporary launch journal failure");
      await expect(supervisor.initialize()).resolves.toBeUndefined();
      expect(reconciliation).toHaveBeenCalledTimes(2);
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 0 },
        { total: 2, available: 2 },
      ]);
      await expect(supervisor.initialize()).resolves.toBeUndefined();
      expect(reconciliation).toHaveBeenCalledTimes(2);
    } finally {
      reconciliation.mockRestore();
      await supervisor.close().catch(() => undefined);
    }
  });

  it("atomically adopts pending work only after the previous supervisor is stale", async () => {
    const { bundleRoot, env, workspaceDir } = fixture("node-worker-stale-pending-");
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    await supervisor.status("schema-probe");
    const input = testWorkerLaunchInput(workspaceDir, "stale-pending-launch");
    await insertLaunch({
      env,
      input,
      state: "pending",
      supervisor: { pid: 2_147_483_647, startTime: 1 },
    });

    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);

    expect(running).toMatchObject({
      state: "running",
      supervisor: requireNodeWorkerProcessIdentity(process.pid),
      worker: { pid: expect.any(Number), startTime: expect.any(Number) },
    });
    await supervisor.close();
  });

  it("releases a stale pending slot during restart reconciliation", async () => {
    const { bundleRoot, env, workspaceDir } = fixture("node-worker-restart-pending-");
    await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get("schema-probe");
    const input = testWorkerLaunchInput(workspaceDir, "restart-pending-launch");
    await insertLaunch({
      env,
      input,
      state: "pending",
      supervisor: { pid: 2_147_483_647, startTime: 1 },
      turn: true,
    });
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });

    await supervisor.initialize();

    expect(await supervisor.status(input.launchId)).toMatchObject({
      state: "interrupted",
      worker: null,
    });
    expect(capacitySnapshots).toEqual([
      { total: 1, available: 0 },
      { total: 1, available: 1 },
    ]);
    await supervisor.close();
  });

  it.runIf(process.platform !== "win32").each([
    { operation: "replay", state: "interrupted", leader: "live" },
    { operation: "cancel", state: "cancelled", leader: "live" },
    { operation: "replay", state: "interrupted", leader: "dead" },
    { operation: "cancel", state: "cancelled", leader: "dead" },
    { operation: "initialize", state: "interrupted", leader: "dead" },
    { operation: "environment stop", state: "cancelled", leader: "live" },
  ])(
    "$operation kills the exact stale-owner worker group with a $leader leader before releasing capacity",
    async ({ operation, state, leader }) => {
      const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-stale-running-");
      const marker = path.join(root, "recovery-grandchild.pid");
      const workerSource = `
        const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", ${JSON.stringify(`
          ${operation === "initialize" ? 'process.on("SIGTERM", () => {});' : ""}
          require("node:fs").writeFileSync(process.argv[1], String(process.pid));
          setInterval(() => {}, 1000);
        `)}, process.argv[1]], { stdio: "ignore" });
        setInterval(() => {}, 1000);
      `;
      const workerProcess = spawn(process.execPath, ["-e", workerSource, marker], {
        detached: true,
        stdio: "ignore",
      });
      spawned.add(workerProcess);
      const worker = requireNodeWorkerProcessIdentity(workerProcess.pid!);
      ownedProcessGroups.push(worker);
      await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toMatch(/^[1-9]\d*$/u));
      const grandchild = requireNodeWorkerProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
      const input = testWorkerLaunchInput(workspaceDir, "stale-running-launch", "wait");
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: operation === "environment stop" ? 4 : 1,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get("schema-probe");
      if (operation !== "initialize") {
        await supervisor.initialize();
      }
      await insertLaunch({
        env,
        input,
        state: "running",
        supervisor: { pid: 2_147_483_647, startTime: 1 },
        worker,
        turn: true,
      });
      if (leader === "dead") {
        workerProcess.kill("SIGKILL");
        await waitForChildExit(workerProcess);
        expect(inspectNodeWorkerProcessIdentity(worker)).toBe("dead");
        expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");
      }

      if (operation === "cancel") {
        await expect(
          supervisor.cancel({ ...testNodeWorkerLaunchIdentity(input), runId: "run-mismatch" }),
        ).resolves.toBeUndefined();
        expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");
      }
      try {
        let recovered: NodeWorkerLaunchReceipt | undefined;
        if (operation === "environment stop") {
          const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
          const liveOwner = testWorkerLaunchInput(workspaceDir, "a-live-owner", "wait");
          const replaced = testWorkerLaunchInput(workspaceDir, "replaced-owner", "wait");
          replaced.descriptor.admission.ownerEpoch += 1;
          for (const pending of [liveOwner, replaced]) {
            await insertLaunch({
              env,
              input: pending,
              state: "pending",
              supervisor: requireNodeWorkerProcessIdentity(process.pid),
            });
          }
          const preserved = [
            await store.get(liveOwner.launchId),
            await store.get(replaced.launchId),
          ];
          const cleanupError = new Error("workspace process cleanup failed");
          const stopWorkspace = vi
            .spyOn(NodeWorkerWorkspaceProcesses.prototype, "stopEnvironment")
            .mockRejectedValueOnce(cleanupError);
          const delayed = testWorkerLaunchInput(workspaceDir, "stalled-readiness-launch", "wait");
          const readiness = holdNodeWorkerReadiness(delayed.launchId);
          const admission = supervisor.launch(delayed, TEST_WORKER_ENDPOINT);
          void admission.catch(() => undefined);
          let stopping: Promise<unknown> | undefined;
          let stopSettled = false;
          try {
            const startupOwner = await withTestTimeout(
              readiness.ready,
              5_000,
              "native readiness was not captured",
            );
            expect((await store.get(delayed.launchId))?.state).toBe("pending");
            expect(inspectNodeWorkerProcessIdentity(startupOwner)).toBe("live");
            stopping = supervisor
              .stopEnvironment(testNodeWorkerEnvironmentIdentity(input))
              .catch((error: unknown) => error)
              .finally(() => {
                stopSettled = true;
              });
            await vi.waitFor(
              async () => {
                expect((await store.get(input.launchId))?.state).toBe("cancelled");
                expect(inspectOwnedNodeWorkerTree(worker)).toBe("dead");
              },
              { timeout: 5_000 },
            );
            expect(stopSettled).toBe(false);
            await expect(
              supervisor.launch(
                testWorkerLaunchInput(workspaceDir, "stop-fenced-launch"),
                TEST_WORKER_ENDPOINT,
              ),
            ).rejects.toThrow("environment is stopping");
            readiness.release();
            const stopError = await stopping;
            await admission;
            expect(fs.existsSync(path.join(workspaceDir, `${delayed.launchId}.started.json`))).toBe(
              false,
            );
            expect((await store.get(input.launchId))?.state).toBe("cancelled");
            expect(stopError).toBeInstanceOf(AggregateError);
            expect(stopError).toMatchObject({
              errors: [
                cleanupError,
                new Error("node worker environment is still owned by another supervisor"),
              ],
            });
            expect([
              await store.get(liveOwner.launchId),
              await store.get(replaced.launchId),
            ]).toEqual(preserved);
            recovered = await store.get(input.launchId);
          } finally {
            readiness.release();
            await Promise.allSettled([admission, stopping]);
            await readiness.close();
            stopWorkspace.mockRestore();
          }
        } else {
          recovered =
            operation === "initialize"
              ? await supervisor.initialize().then(() => supervisor.status(input.launchId))
              : operation === "cancel"
                ? await supervisor.cancel(testNodeWorkerLaunchIdentity(input))
                : await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        }

        expect(recovered).toMatchObject({ state, worker });
        await waitForIdentityDeath(worker);
        await waitForIdentityDeath(grandchild);
        expect((await supervisor.status(input.launchId))?.worker).toEqual(worker);
        expect(capacitySnapshots.at(-1)).toEqual({
          total: operation === "environment stop" ? 4 : 1,
          available: operation === "environment stop" ? 2 : 1,
        });
        expect(await supervisor.hasActiveWork()).toBe(operation === "environment stop");
      } finally {
        await supervisor.close();
      }
    },
  );

  it("returns a live foreign running receipt from a real second process without mutation", async () => {
    const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-live-replay-");
    const input = testWorkerLaunchInput(workspaceDir, "live-running-launch", "wait");
    const owner = spawnSupervisorOwner({ bundleRoot, env, input, root });
    spawned.add(owner);
    const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
    if (owned.worker) {
      ownedProcessGroups.push(owned.worker);
    }
    const second = createNodeWorkerSupervisor({ bundleRoot, env });

    const unchanged = await second.cancel(testNodeWorkerLaunchIdentity(input));
    if (process.platform === "linux") {
      const originalReadFileSync = fs.readFileSync;
      const supervisorStatPath = `/proc/${owned.supervisor.pid}/stat`;
      const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...args: unknown[]
      ) => {
        if (file === supervisorStatPath) {
          throw new Error("injected unknown process identity");
        }
        return Reflect.apply(originalReadFileSync, fs, [file, ...args]);
      }) as typeof fs.readFileSync);
      try {
        await expect(second.cancel(testNodeWorkerLaunchIdentity(input))).resolves.toEqual(owned);
        expect(inspectNodeWorkerProcessIdentity(owned.worker!)).toBe("live");
      } finally {
        readFileSync.mockRestore();
      }
    }
    const replay = await second.launch(input, TEST_WORKER_ENDPOINT);

    expect(unchanged).toEqual(owned);
    expect(replay).toEqual(owned);
    expect(inspectNodeWorkerProcessIdentity(owned.supervisor)).toBe("live");
    expect(inspectNodeWorkerProcessIdentity(owned.worker!)).toBe("live");
    owner.kill("SIGTERM");
    await waitForChildExit(owner);
    await second.close();
  });

  it.runIf(process.platform !== "win32").each([false, true])(
    "uses IPC disconnect after owner SIGKILL, then reconciles only after exact tree death (external=%s)",
    async (external) => {
      const {
        bundleRoot,
        env: fixtureEnv,
        root,
        workspaceDir,
      } = fixture("node-worker-owner-kill-");
      const env = { ...fixtureEnv, ...(external ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}) };
      if (external) {
        claimOpenClawStateOwnership("node-recovery-test", { env });
      }
      const input = testWorkerLaunchInput(workspaceDir, "owner-kill-launch", "tree");
      const workerModePath = path.join(workspaceDir, "worker-supervision.json");
      fs.appendFileSync(
        path.join(bundleRoot, "gateway-1", "bundles", input.expectedBundleHash, "worker.mjs"),
        `\nfs.writeFileSync(${JSON.stringify(workerModePath)}, JSON.stringify({ externalMode: process.env.OPENCLAW_SUPERVISOR_MODE ?? null }));\n`,
      );
      const owner = spawnSupervisorOwner({ bundleRoot, env, input, root });
      spawned.add(owner);
      const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
      ownedProcessGroups.push(owned.worker!);
      const grandchildPath = path.join(workspaceDir, "grandchild.pid");
      await vi.waitFor(() =>
        expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u),
      );
      const grandchild = requireNodeWorkerProcessIdentity(
        Number(fs.readFileSync(grandchildPath, "utf8")),
      );
      expect(JSON.parse(fs.readFileSync(workerModePath, "utf8"))).toEqual({ externalMode: null });

      owner.kill("SIGKILL");
      await waitForChildExit(owner);
      await waitForIdentityDeath(owned.supervisor);
      await waitForIdentityDeath(owned.worker!);
      await waitForIdentityDeath(grandchild);
      expect(
        await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
      ).toMatchObject({
        state: "running",
        workerCleanupMode: "owned-anchor",
        workerLineageSettled: true,
      });

      const capacities: Array<{ total: number; available: number }> = [];
      const restarted = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: 1,
        onCapacityChanged: (capacity) => capacities.push(capacity),
      });
      const reconciled = await restarted.status(input.launchId);
      expect(reconciled).toMatchObject({
        state: "interrupted",
        supervisor: owned.supervisor,
        worker: owned.worker,
        workerCleanupMode: "owned-anchor",
        workerLineageSettled: true,
      });
      expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
      await restarted.close();
    },
  );

  it("keeps a live foreign pending claim unchanged across real processes", async () => {
    const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-live-pending-");
    const input = testWorkerLaunchInput(workspaceDir, "live-pending-launch", "wait");
    const claim = {
      launchId: input.launchId,
      planHash: testNodeWorkerLaunchIdentity(input).planHash,
      gatewayNamespace: input.gatewayNamespace,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
    };
    const owner = spawnPendingSupervisorOwner({ root, env, claim });
    spawned.add(owner);
    const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
    const second = createNodeWorkerSupervisor({ bundleRoot, env });

    const replay = await second.launch(input, TEST_WORKER_ENDPOINT);

    expect(replay).toEqual(owned);
    owner.kill("SIGKILL");
    await waitForChildExit(owner);
    await second.close();
  });

  it.each(["pending", "running"] as const)(
    "revalidates the %s physical owner after awaited container cleanup work",
    async (state) => {
      const { bundleRoot, env, workspaceDir } = fixture("node-worker-recovery-reread-");
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      await store.get("schema-probe");
      const input = testWorkerLaunchInput(workspaceDir, "recovery-reread");
      const stale = { pid: 2_147_483_647, startTime: 1 };
      const current = requireNodeWorkerProcessIdentity(process.pid);
      await insertLaunch({ env, input, state: "pending", supervisor: stale });
      const engine = { id: "docker", command: process.execPath, target: "b".repeat(64) } as const;
      const container = {
        engine: engine.id,
        containerId: "c".repeat(64),
        engineTarget: engine.target,
      } as const;
      if (state === "running") {
        await store.markRunning({
          launchId: input.launchId,
          planHash: testNodeWorkerLaunchIdentity(input).planHash,
          supervisor: stale,
          worker: current,
          cleanupMode: null,
          container,
        });
      }
      const receipt = (await store.get(input.launchId))!;
      const lifecycle = new NodeWorkerContainerLifecycle(engine, bundleRoot, store);
      const replaceOwner = async () => {
        await Promise.resolve();
        openOpenClawStateDatabase({ env })
          .db.prepare(
            "UPDATE node_worker_launches SET supervisor_pid = ?, supervisor_start_time = ? WHERE launch_id = ?",
          )
          .run(current.pid, current.startTime, input.launchId);
      };
      const initialize = vi.spyOn(lifecycle, "initialize").mockImplementation(replaceOwner);
      const inspect = vi.spyOn(lifecycle, "inspect").mockImplementation(async () => {
        await replaceOwner();
        return "live";
      });
      const remove = vi.spyOn(lifecycle, "remove").mockResolvedValue(undefined);
      try {
        await expect(
          createNodeWorkerLaunchRecovery({
            isRecoveryActive: () => true,
            store,
            capacity: new NodeWorkerCapacity(store, { capacity: 1 }),
            containerLifecycle: lifecycle,
            recoveries: new Map(),
          })(receipt, true, "cancelled"),
        ).resolves.toMatchObject({ state, supervisor: current });
        expect(remove).not.toHaveBeenCalled();
        expect(await store.nonterminalCount()).toBe(1);
      } finally {
        initialize.mockRestore();
        inspect.mockRestore();
        remove.mockRestore();
      }
    },
  );
});
