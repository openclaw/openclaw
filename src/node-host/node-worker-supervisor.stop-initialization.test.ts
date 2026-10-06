import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type { NodeWorkerWorkspaceExecInput } from "../worker/node-workspace-protocol.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerContainerFixture } from "./node-worker-supervisor.container.test-support.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForChildExit,
  waitForChildLine,
  waitForIdentityDeath,
  spawnSupervisorOwner,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { inspectOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useStateDatabaseTempDirs();
const fileLockModule = createRequire(import.meta.url).resolve("@openclaw/fs-safe/file-lock");

describe("node worker environment stop after failed initialization", () => {
  it.each([false, true])(
    "holds workspace admission through supervisor settlement (fails: %s)",
    async (fails) => {
      const root = tempDirs.make("node-worker-stop-settlement-");
      const workspace = new NodeWorkerWorkspaceRuntime({
        root,
        env: {
          PATH: path.dirname(process.execPath),
          HOME: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      });
      const { supervisor } = createNodeWorkerSupervisorFixture(root, { workspace });
      const entered = createDeferred();
      const finish = createDeferred();
      const failure = new Error("worker journal cleanup is uncertain");
      const initialize = supervisor.initialize.bind(supervisor);
      vi.spyOn(supervisor, "initialize").mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
        if (fails) {
          throw failure;
        }
        await initialize();
      });
      const identity = {
        gatewayNamespace: "gateway-preview",
        environmentId: "worker:preview",
        sessionId: "conversation-preview",
        generation: 1,
      };
      const command: NodeWorkerWorkspaceExecInput = {
        ...identity,
        nativeProcessOwner: true,
        argv: [path.basename(process.execPath), "-e", "process.stdout.write('fresh')"],
      };
      const stopping = supervisor.stopEnvironment({ ...identity, ownerEpoch: 1 });
      void stopping.catch(() => undefined);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          stopping,
          "supervisor cleanup did not begin",
        );
        await expect(workspace.exec(command)).rejects.toThrow("retired");
        expect(() =>
          supervisor.observeProcesses({
            ...identity,
            ownerEpoch: 1,
            placementGeneration: 1,
            expectedBundleHash: "a".repeat(64),
            operation: { action: "list" },
          }),
        ).toThrow("retired");
        finish.resolve();
        if (fails) {
          await expect(stopping).rejects.toBe(failure);
          await expect(workspace.exec(command)).rejects.toThrow("retired");
          await supervisor.stopEnvironment({ ...identity, ownerEpoch: 1 });
        } else {
          await stopping;
        }
        expect((await workspace.exec(command)).stdout).toBe("fresh");
      } finally {
        finish.resolve();
        await stopping.catch(() => undefined);
        await supervisor.close();
      }
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "settles native recovery without publishing capacity until the unrelated container recovers",
    async () => {
      const cleanupMode =
        process.platform === "linux" && !process.versions.bun ? "linux-subreaper" : "owned-anchor";
      const capacities: Array<{ total: number; available: number }> = [];
      const root = tempDirs.make("node-worker-stop-initialization-");
      const fixture = createNodeWorkerContainerFixture(root, fileLockModule, {
        capacity: 3,
        onCapacityChanged: (capacity) => capacities.push(capacity),
      });
      fs.writeFileSync(fixture.bundleEntry, TEST_WORKER_SOURCE);
      const native = testWorkerLaunchInput(fixture.workspaceDir, "a-native-owner", "wait");
      native.descriptor.admission.environmentId = "native-environment";
      native.descriptor.admission.sessionId = "native-session";
      const owner = spawnSupervisorOwner({
        bundleRoot: fixture.bundleRoot,
        env: fixture.env,
        input: native,
        root,
      });
      let anchor: NodeWorkerProcessIdentity | undefined;
      let stopping: Promise<unknown> | undefined;
      let bodyFailure: { error: unknown } | undefined;
      await (async () => {
        const receipt = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
        anchor = receipt.worker!;
        expect(receipt.workerCleanupMode).toBe(cleanupMode);
        process.kill(anchor.pid, "SIGSTOP");
        owner.kill("SIGKILL");
        await waitForChildExit(owner);

        const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));
        const live = testWorkerLaunchInput(fixture.workspaceDir, "m-live-pending");
        await store.claim(
          { ...testNodeWorkerLaunchIdentity(live), gatewayNamespace: live.gatewayNamespace },
          requireNodeWorkerProcessIdentity(process.pid),
          3,
        );
        const blocked = testWorkerLaunchInput(fixture.workspaceDir, "z-blocked-container");
        const container = fixture.seed({ id: "d".repeat(64), launchId: blocked.launchId });
        const staleSupervisor = { pid: 2_147_483_647, startTime: 1 };
        const claim = {
          ...testNodeWorkerLaunchIdentity(blocked),
          gatewayNamespace: blocked.gatewayNamespace,
        };
        await store.claim(claim, staleSupervisor, 3);
        await store.markRunning({
          ...claim,
          supervisor: staleSupervisor,
          worker: { pid: 2_147_483_646, startTime: 1 },
          cleanupMode: null,
          container: {
            engine: "docker",
            engineTarget: fixture.containerEngine.target,
            containerId: container.id,
          },
        });
        const preserved = [await store.get(live.launchId), await store.get(blocked.launchId)];
        expect((await store.listNonterminal()).map((entry) => entry.launchId)).toEqual([
          native.launchId,
          live.launchId,
          blocked.launchId,
        ]);
        const failureMarker = path.join(fixture.engineRoot, "fail-removal");
        fs.writeFileSync(failureMarker, "fail");
        const failedInitialization = /injected container removal failure/u;
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
        expect(await store.get(native.launchId)).toMatchObject({
          state: "running",
          workerLineageSettled: false,
          ...(cleanupMode === "linux-subreaper" ? { workerDescendantsReaped: false } : {}),
        });
        expect(capacities).toEqual([{ total: 3, available: 0 }]);

        const settled = vi.fn();
        stopping = fixture.supervisor
          .stopEnvironment(testNodeWorkerEnvironmentIdentity(native))
          .then(settled, (error: unknown) => {
            settled();
            return error;
          });
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        process.kill(anchor.pid, "SIGCONT");
        expect(await stopping).toMatchObject({
          message: expect.stringMatching(failedInitialization),
        });
        expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead");
        const cancelled = await store.get(native.launchId);
        expect(cancelled).toMatchObject({
          state: "cancelled",
          workerLineageSettled: cleanupMode === "owned-anchor",
          ...(cleanupMode === "linux-subreaper" ? { workerDescendantsReaped: true } : {}),
        });
        expect([await store.get(live.launchId), await store.get(blocked.launchId)]).toEqual(
          preserved,
        );
        expect(fixture.exists(container.id)).toBe(true);
        await expect(fixture.supervisor.status(native.launchId)).rejects.toThrow(
          failedInitialization,
        );
        await expect(
          fixture.supervisor.launch(
            testWorkerLaunchInput(fixture.workspaceDir, "still-unavailable"),
            TEST_WORKER_ENDPOINT,
          ),
        ).rejects.toThrow(failedInitialization);
        for (const capacity of capacities) {
          expect(capacity).toEqual({ total: 3, available: 0 });
        }
        expect(await fixture.supervisor.hasActiveWork()).toBe(true);

        fs.unlinkSync(failureMarker);
        await fixture.supervisor.initialize();
        expect(capacities.at(-1)).toEqual({ total: 3, available: 2 });
        expect(await store.get(native.launchId)).toEqual(cancelled);
        expect(await store.get(live.launchId)).toEqual(preserved[0]);
        expect((await store.get(blocked.launchId))?.state).toBe("interrupted");
        expect(fixture.exists(container.id)).toBe(false);
        expect(await store.nonterminalCount()).toBe(1);
        expect(await fixture.supervisor.status(native.launchId)).toMatchObject({
          state: "cancelled",
        });
      })().catch((error: unknown) => {
        bodyFailure = { error };
      });
      const resumed = Promise.resolve().then(() => {
        if (anchor && inspectNodeWorkerProcessIdentity(anchor) === "live") {
          process.kill(anchor.pid, "SIGCONT");
        }
      });
      const ownerExit = resumed
        .catch(() => undefined)
        .then(async () => {
          if (owner.exitCode === null && owner.signalCode === null) {
            owner.kill("SIGTERM");
          }
          await waitForChildExit(owner);
        });
      const cleanupErrors = (
        await Promise.allSettled([
          resumed,
          ownerExit,
          stopping,
          Promise.resolve().then(() => fixture.supervisor.close()),
          resumed.catch(() => undefined).then(() => anchor && waitForIdentityDeath(anchor)),
        ])
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          bodyFailure ? [bodyFailure.error, ...cleanupErrors] : cleanupErrors,
          "mixed worker recovery fixture cleanup failed",
          { cause: bodyFailure ? bodyFailure.error : cleanupErrors[0] },
        );
      }
      if (bodyFailure) {
        throw bodyFailure.error;
      }
    },
  );
});
