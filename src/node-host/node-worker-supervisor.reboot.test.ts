import { describe, expect, it, vi } from "vitest";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { createNodeWorkerLaunchRecovery } from "./node-worker-supervisor-recovery.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const tempDirs = useStateDatabaseTempDirs();
function fixture(label: string) {
  return writeNodeWorkerFixture(tempDirs.make(label));
}

describe("node worker reboot recovery", () => {
  it.each([
    { recorded: "boot-a", current: "boot-b", expected: "boot-b" },
    { recorded: "boot-a", current: null, expected: undefined },
    { recorded: null, current: "boot-b", expected: undefined },
  ])(
    "keeps boot identity with adopted pending ownership: $recorded to $current",
    async ({ recorded, current, expected }) => {
      const { env, workspaceDir } = fixture("node-worker-adopted-boot-");
      const journal = new NodeWorkerJournalWorker({ env });
      const store = new NodeWorkerLaunchStore(journal);
      const input = testWorkerLaunchInput(workspaceDir, "adopted-boot");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      const boot = vi.spyOn(processIdentity, "getNodeWorkerBootIdentity").mockReturnValue(recorded);
      const owner = requireNodeWorkerProcessIdentity(process.pid);
      try {
        await store.claim(claim, { pid: 2_147_483_647, startTime: 1 }, 4);
        boot.mockReturnValue(current);
        const adopted = await store.claim(claim, owner, 4);
        expect(adopted).toMatchObject({ action: "start", receipt: { supervisor: owner } });
        if (adopted.action === "at-capacity") {
          throw new Error("pending adoption unexpectedly exhausted capacity");
        }
        expect(adopted.receipt.bootId).toBe(expected);
        const running = await store.markRunning({
          ...claim,
          supervisor: owner,
          worker: owner,
          cleanupMode: "linux-subreaper",
        });
        const capacity = new NodeWorkerCapacity(store, { capacity: 4 });
        const recover = createNodeWorkerLaunchRecovery({
          store,
          capacity,
          isRecoveryActive: () => true,
          recoveries: new Map(),
        });
        expect(await recover(running)).toMatchObject({ state: "running" });
        expect(await store.nonterminalCount()).toBe(1);
        capacity.close();
      } finally {
        boot.mockRestore();
        await journal.drain();
      }
    },
  );

  it.each([
    { mode: null, recorded: "boot-a", current: "boot-b", interrupted: true },
    { mode: "owned-anchor", recorded: "boot-a", current: "boot-b", interrupted: true },
    { mode: "linux-subreaper", recorded: "boot-a", current: "boot-b", interrupted: true },
    { mode: "linux-subreaper", recorded: "boot-a", current: "boot-a", interrupted: false },
    { mode: "linux-subreaper", recorded: "boot-a", current: null, interrupted: false },
    { mode: "linux-subreaper", recorded: null, current: "boot-b", interrupted: false },
  ] as const)(
    "$mode recovery from $recorded to $current releases capacity only for a proven reboot",
    async ({ mode, recorded, current, interrupted }) => {
      const { env, workspaceDir } = fixture("node-worker-reboot-");
      const journal = new NodeWorkerJournalWorker({ env });
      const store = new NodeWorkerLaunchStore(journal);
      const turns = new NodeWorkerTurnStore(journal);
      const input = testWorkerLaunchInput(workspaceDir, "reboot-launch");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      // Reused PID/start ticks must not defeat boot identity; no real process is killed.
      const owner = requireNodeWorkerProcessIdentity(process.pid);
      const boot = vi.spyOn(processIdentity, "getNodeWorkerBootIdentity").mockReturnValue(recorded);
      const snapshots: Array<{ total: number; available: number }> = [];
      const capacity = new NodeWorkerCapacity(store, {
        capacity: 4,
        onCapacityChanged: (value) => snapshots.push(value),
      });
      const recover = createNodeWorkerLaunchRecovery({
        store,
        capacity,
        isRecoveryActive: () => true,
        recoveries: new Map(),
      });
      try {
        const created = await store.claim(claim, owner, 4);
        expect(created).toMatchObject({
          action: "start",
          receipt: recorded ? { bootId: recorded } : {},
        });
        await turns.claim({ claim, ownerLaunchId: claim.launchId, supervisor: owner });
        if (mode) {
          await store.markRunning({
            ...claim,
            supervisor: owner,
            worker: owner,
            cleanupMode: mode,
          });
        }
        boot.mockReturnValue(current);
        await capacity.initialize(async (receipt) => {
          await recover(receipt, false);
        });
        const state = interrupted ? "interrupted" : mode ? "running" : "pending";
        expect(await store.get(claim.launchId)).toMatchObject({ state });
        expect(await turns.get(claim.launchId)).toMatchObject({
          state: interrupted ? "interrupted" : "running",
        });
        expect(await store.nonterminalCount()).toBe(interrupted ? 0 : 1);
        expect(snapshots.at(-1)).toEqual({ total: 4, available: interrupted ? 4 : 3 });
        if (interrupted) {
          expect(await turns.get(claim.launchId)).toMatchObject({
            errorText: "node host rebooted before the worker launch completed",
          });
        }
      } finally {
        boot.mockRestore();
        capacity.close();
        await journal.drain();
      }
    },
  );
});
