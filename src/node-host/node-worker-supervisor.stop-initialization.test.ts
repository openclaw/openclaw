import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerContainerFixture } from "./node-worker-supervisor.container.test-support.js";
import {
  waitForChildExit,
  waitForChildLine,
  waitForIdentityDeath,
  writeSupervisorOwnerScript,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { inspectOwnedNodeWorkerTree } from "./node-worker-tree-control.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fileLockModule = createRequire(import.meta.url).resolve("@openclaw/fs-safe/file-lock");
afterEach(() => closeOpenClawStateDatabaseForTest());

describe("node worker environment stop after failed initialization", () => {
  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "settles native recovery without publishing capacity until the unrelated container recovers",
    async () => {
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
      const inputPath = path.join(root, "native-input.json");
      fs.writeFileSync(inputPath, JSON.stringify(native));
      const owner = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          writeSupervisorOwnerScript(root),
          fixture.bundleRoot,
          fixture.stateDir,
          inputPath,
        ],
        { env: { ...process.env, ...fixture.env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let anchor: NodeWorkerProcessIdentity | undefined;
      let stopping: Promise<unknown> | undefined;
      let bodyFailure: { error: unknown } | undefined;
      await (async () => {
        const receipt = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
        expect(receipt.workerCleanupMode).toBe("owned-anchor");
        anchor = receipt.worker!;
        process.kill(anchor.pid, "SIGSTOP");
        owner.kill("SIGKILL");
        await waitForChildExit(owner);

        const store = new NodeWorkerLaunchStore({ env: fixture.env });
        const live = testWorkerLaunchInput(fixture.workspaceDir, "m-live-pending");
        store.claim(
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
        store.claim(claim, staleSupervisor, 3);
        store.markRunning({
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
        const preserved = [store.get(live.launchId), store.get(blocked.launchId)];
        expect(store.listNonterminal().map((entry) => entry.launchId)).toEqual([
          native.launchId,
          live.launchId,
          blocked.launchId,
        ]);
        const failureMarker = path.join(fixture.engineRoot, "fail-removal");
        fs.writeFileSync(failureMarker, "fail");
        const failedInitialization = /injected container removal failure/u;
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
        expect(store.get(native.launchId)).toMatchObject({
          state: "running",
          workerLineageSettled: false,
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
        const cancelled = store.get(native.launchId);
        expect(cancelled).toMatchObject({ state: "cancelled", workerLineageSettled: true });
        expect([store.get(live.launchId), store.get(blocked.launchId)]).toEqual(preserved);
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
        expect(fixture.supervisor.hasActiveWork()).toBe(true);

        fs.unlinkSync(failureMarker);
        await fixture.supervisor.initialize();
        expect(capacities.at(-1)).toEqual({ total: 3, available: 2 });
        expect(store.get(native.launchId)).toEqual(cancelled);
        expect(store.get(live.launchId)).toEqual(preserved[0]);
        expect(store.get(blocked.launchId)?.state).toBe("interrupted");
        expect(fixture.exists(container.id)).toBe(false);
        expect(store.nonterminalCount()).toBe(1);
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
