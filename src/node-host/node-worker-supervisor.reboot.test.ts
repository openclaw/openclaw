import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
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
afterEach(() => vi.restoreAllMocks());
function fixture(label: string, launchId: string, total = 4) {
  const value = writeNodeWorkerFixture(tempDirs.make(label));
  const journal = new NodeWorkerJournalWorker({ env: value.env });
  const store = new NodeWorkerLaunchStore(journal);
  const input = testWorkerLaunchInput(value.workspaceDir, launchId);
  const owner = requireNodeWorkerProcessIdentity(process.pid);
  const claim = {
    ...testNodeWorkerLaunchIdentity(input),
    gatewayNamespace: input.gatewayNamespace,
  };
  const snapshots: Array<{ total: number; available: number }> = [];
  const capacity = new NodeWorkerCapacity(store, {
    capacity: total,
    onCapacityChanged: (snapshot) => snapshots.push(snapshot),
  });
  return {
    capacity,
    snapshots,
    ...value,
    journal,
    store,
    owner,
    claim,
    recover() {
      return createNodeWorkerLaunchRecovery({
        store,
        capacity,
        isRecoveryActive: () => true,
        recoveries: new Map(),
      });
    },
    async [Symbol.asyncDispose]() {
      capacity.close();
      await journal.drain();
    },
  };
}

describe("node worker reboot recovery", () => {
  it("reports a failed capacity refresh without losing committed completion or advertising free capacity", async () => {
    const f = fixture("node-worker-capacity-refresh-", "refresh-failure", 1);
    const { root, store, owner: supervisor, claim, snapshots, capacity } = f;
    const logPath = path.join(root, "capacity.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });
    try {
      await capacity.initialize(async () => {});
      await capacity.claim(claim, supervisor);
      vi.spyOn(store, "nonterminalCount").mockRejectedValueOnce(new Error("private query detail"));

      await expect(
        capacity.finish({
          launchId: claim.launchId,
          planHash: claim.planHash,
          supervisor,
          worker: null,
          state: "cancelled",
          errorText: "cancelled before worker startup",
        }),
      ).resolves.toMatchObject({ state: "cancelled" });
      expect(await store.get(claim.launchId)).toMatchObject({ state: "cancelled" });
      expect(snapshots.at(-1)).toEqual({ total: 1, available: 0 });
      await flushLogger();
      const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      expect(output).toContain("Worker capacity refresh failed");
      expect(output).toContain("Restart the node host if capacity does not recover");
      expect(output).not.toContain("private query detail");
    } finally {
      capacity.close();
      await f.journal.drain();
      await flushLogger();
      setLoggerOverride(null);
    }
  });

  it.each([
    { recorded: "boot-a", current: "boot-b", expected: "boot-b" },
    { recorded: "boot-a", current: null, expected: undefined },
    { recorded: null, current: "boot-b", expected: undefined },
  ])(
    "keeps boot identity with adopted pending ownership: $recorded to $current",
    async ({ recorded, current, expected }) => {
      await using f = fixture("node-worker-adopted-boot-", "adopted-boot");
      const { store, claim, owner } = f;
      const boot = vi.spyOn(processIdentity, "getNodeWorkerBootIdentity").mockReturnValue(recorded);
      await store.claim(claim, { pid: 2_147_483_647, startTime: 1 }, 4, 1_007);
      boot.mockReturnValue(current);
      const adopted = await store.claim(claim, owner, 4, 1_000);
      expect(adopted).toMatchObject({ action: "start", receipt: { supervisor: owner } });
      if (adopted.action === "at-capacity") {
        throw new Error("pending adoption unexpectedly exhausted capacity");
      }
      expect(adopted.receipt.bootId).toBe(expected);
      expect(adopted.receipt.updatedAtMs).toBe(1_007);
      const running = await store.markRunning({
        ...claim,
        supervisor: owner,
        worker: owner,
        cleanupMode: "linux-subreaper",
      });
      expect(await f.recover()(running)).toMatchObject({ state: "running" });
      expect(await store.nonterminalCount()).toBe(1);
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
      await using f = fixture("node-worker-reboot-", "reboot-launch");
      const { store, claim, owner, capacity } = f;
      const turns = new NodeWorkerTurnStore(f.journal);
      // Reused PID/start ticks must not defeat boot identity; no real process is killed.
      const boot = vi.spyOn(processIdentity, "getNodeWorkerBootIdentity").mockReturnValue(recorded);
      const { snapshots } = f;
      const recover = f.recover();
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
    },
  );
});
