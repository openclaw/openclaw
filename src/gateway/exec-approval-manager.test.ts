/**
 * Tests exec approval manager state transitions and timeout behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function installTimerMocks() {
    const timers: Array<{
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      void callback;
      const handle = { unref: vi.fn() } as unknown as MockTimerHandle;
      timers.push({ delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );

    return timers;
  }

  it("does not keep resolved approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-resolve");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolve("approval-resolve", "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("does not keep expired approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-expire");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire("approval-expire")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("clamps oversized approval timers instead of letting Node fire them immediately", () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      { command: "echo ok" },
      MAX_TIMER_TIMEOUT_MS + 1,
      "approval-long",
    );

    void manager.register(record, MAX_TIMER_TIMEOUT_MS + 1);

    expect(record.expiresAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(timers[0]?.delay).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("rejects approval records when expiry would exceed the Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const manager = new ExecApprovalManager();

    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });

  describe("classifyApprovalId", () => {
    it("classifies pending, unknown, and unseen ids without leaking existence", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create({ command: "echo ok" }, 60_000, "approval-classify-pending");
      void manager.register(record, 60_000);

      expect(manager.classifyApprovalId("approval-classify-pending")).toBe("pending");
      expect(manager.classifyApprovalId("never-existed")).toBe("unknown");
      expect(manager.classifyApprovalId("   ")).toBe("unknown");
      // A record the caller cannot see must not be revealed as pending.
      expect(manager.classifyApprovalId("approval-classify-pending", { filter: () => false })).toBe(
        "unknown",
      );

      manager.resolve("approval-classify-pending", "allow-once");
    });

    it("distinguishes resolved from expired records still inside the grace window", () => {
      const manager = new ExecApprovalManager();
      const resolvedRecord = manager.create(
        { command: "echo ok" },
        60_000,
        "approval-grace-resolved",
      );
      void manager.register(resolvedRecord, 60_000);
      expect(manager.resolve("approval-grace-resolved", "allow-once")).toBe(true);
      expect(manager.classifyApprovalId("approval-grace-resolved")).toBe("resolved");

      const expiredRecord = manager.create(
        { command: "echo ok" },
        60_000,
        "approval-grace-expired",
      );
      void manager.register(expiredRecord, 60_000);
      expect(manager.expire("approval-grace-expired")).toBe(true);
      expect(manager.classifyApprovalId("approval-grace-expired")).toBe("expired");
    });

    it("keeps resolved/expired classification after the grace window archives the record", () => {
      vi.useFakeTimers();
      try {
        const manager = new ExecApprovalManager();
        const resolvedRecord = manager.create(
          { command: "echo ok" },
          600_000,
          "approval-archive-resolved",
        );
        void manager.register(resolvedRecord, 600_000);
        manager.resolve("approval-archive-resolved", "allow-once");

        const expiredRecord = manager.create(
          { command: "echo ok" },
          600_000,
          "approval-archive-expired",
        );
        void manager.register(expiredRecord, 600_000);
        manager.expire("approval-archive-expired");

        // Fire the 15s grace cleanup; the live records are dropped but archived.
        vi.advanceTimersByTime(15_000);

        expect(manager.getSnapshot("approval-archive-resolved")).toBeNull();
        expect(manager.getSnapshot("approval-archive-expired")).toBeNull();
        expect(manager.classifyApprovalId("approval-archive-resolved")).toBe("resolved");
        expect(manager.classifyApprovalId("approval-archive-expired")).toBe("expired");
      } finally {
        vi.useRealTimers();
      }
    });

    it("classifies a consumed allow-once approval as resolved", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create({ command: "echo ok" }, 60_000, "approval-consumed");
      void manager.register(record, 60_000);
      manager.resolve("approval-consumed", "allow-once");
      expect(manager.consumeAllowOnce("approval-consumed")).toBe(true);
      // decision moved to consumedDecision; still a resolved terminal state.
      expect(manager.classifyApprovalId("approval-consumed")).toBe("resolved");
    });

    it("evicts the oldest archived terminal record beyond the bounded cap", () => {
      vi.useFakeTimers();
      try {
        const manager = new ExecApprovalManager();
        // Cap is MAX_RECENTLY_TERMINATED (512). Archive one past it and assert FIFO eviction.
        const total = 513;
        for (let index = 0; index < total; index += 1) {
          const id = `approval-evict-${index}`;
          const record = manager.create({ command: "echo ok" }, 600_000, id);
          void manager.register(record, 600_000);
          manager.resolve(id, "allow-once");
        }
        vi.advanceTimersByTime(15_000);

        expect(manager.classifyApprovalId("approval-evict-0")).toBe("unknown");
        expect(manager.classifyApprovalId(`approval-evict-${total - 1}`)).toBe("resolved");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
