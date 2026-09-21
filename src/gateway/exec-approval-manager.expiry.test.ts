// Focused coverage for timer-driven approval expiry publication; the main
// exec-approval-manager suite sits at the max-lines cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createTestApprovalManager,
  installTestApprovalClock,
} from "./exec-approval-manager.test-support.js";
import * as operatorApprovalStore from "./operator-approval-store.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager timeout expiry publication", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(path.join(dir, "s.sqlite"));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function installTimerMocks() {
    const timers: Array<{
      callback: TimeoutCallback;
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      const handle = {
        unref: vi.fn(),
        refresh: vi.fn().mockReturnThis(),
      } as unknown as MockTimerHandle;
      timers.push({ callback, delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );
    return timers;
  }

  it("rejects approval records when expiry would exceed the Date range", (testContext) => {
    const manager = createTestApprovalManager(testContext);
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });

  it.each(["cancellation", "storage repair"] as const)(
    "lets the deadline win when %s waits for transaction admission",
    async (operation) => {
      installTimerMocks();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-queued-expiry-"));
      tempDirs.push(dir);
      const manager = new ExecApprovalManager({
        persistence: {
          runtimeEpoch: "queued-expiry",
          databaseOptions: { path: path.join(dir, "s.sqlite") },
        },
      });
      const record = manager.create({ command: "echo queued" }, 1_000, "queued-expiry");
      const { decision } = await manager.register(record, 1_000);
      if (operation === "storage repair") {
        const failedResolve = vi
          .spyOn(operatorApprovalStore, "resolveOperatorApproval")
          .mockRejectedValueOnce(new Error("synthetic storage failure"));
        await expect(manager.resolve(record.id, "allow-once")).rejects.toThrow(
          "synthetic storage failure",
        );
        failedResolve.mockRestore();
      }

      const entered = createDeferredCore();
      const admitted = createDeferredCore<number>();
      const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
      vi.spyOn(operatorApprovalStore, "forceDenyOperatorApproval").mockImplementation(
        async (params) => {
          entered.resolve();
          const admittedNowMs = await admitted.promise;
          return forceDeny({ ...params, nowMs: params.nowMs ?? admittedNowMs });
        },
      );
      const transition =
        operation === "cancellation"
          ? manager.forceDenyDetailed(
              record.id,
              "run-aborted",
              { kind: "system", id: "fixture" },
              "cancelled",
            )
          : manager.resolveDetailed(record.id, "deny", { kind: "system", id: "fixture" });
      try {
        await entered.promise;
        clock.mockReturnValue(record.expiresAtMs);
        admitted.resolve(record.expiresAtMs);
        await expect(transition).resolves.toMatchObject({
          outcome: "expired",
          record: {
            status: "expired",
            terminalReason: "timeout",
            resolvedAtMs: record.expiresAtMs,
          },
        });
        await expect(decision).resolves.toBe(operation === "cancellation" ? null : "deny");
      } finally {
        admitted.resolve(record.expiresAtMs);
        await transition.catch(() => undefined);
        await manager.drain();
      }
    },
  );

  it("publishes timer-driven timeout expiry through onExpired", async () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    installTestApprovalClock();
    const expirations: Array<{ recordId: string; status: string; requestCommand?: string }> = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-expired-"));
    tempDirs.push(dir);
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "runtime-a",
        databaseOptions: { path: path.join(dir, "s.sqlite") },
      },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      onExpired: (record, liveRecord) =>
        expirations.push({
          recordId: record.id,
          status: record.status,
          requestCommand: liveRecord.request.command,
        }),
    });
    const record = manager.create({ command: "echo expired" }, 60_000, "approval-on-expired");
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    const deadlines = timers.filter(({ handle }) => handle.unref.mock.calls.length === 0);
    expect(deadlines).toHaveLength(1);
    const timer = deadlines[0];
    if (!timer || typeof timer.callback !== "function") {
      throw new Error("expected timer callback");
    }
    timer.callback();

    await expect(decisionPromise).resolves.toBeNull();
    // The gateway clock owns expiry: reviewer surfaces get the terminal fact
    // (with the live request for the event payload) instead of inferring it.
    expect(expirations).toEqual([
      { recordId: record.id, status: "expired", requestCommand: "echo expired" },
    ]);
  });

  it("rejects ask-fallback replay of a run-aborted cancellation", async (testContext) => {
    installTimerMocks();
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-cancelled");
    const decisionPromise = (await manager.register(record, 60_000)).decision;

    // Dispatch fencing / run abort ends decision-less like a timeout, but its
    // authority closed deliberately — replay must not re-admit through it.
    const denied = await manager.forceDenyDetailed(
      "approval-cancelled",
      "run-aborted",
      { kind: "system", id: "worker-dispatch" },
      "cancelled",
    );
    expect(denied.outcome).toBe("denied");
    await expect(decisionPromise).resolves.toBeNull();

    expect(await manager.getSnapshot("approval-cancelled")).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    expect(manager.consumeAskFallback("approval-cancelled")).toBe(false);
  });
});
