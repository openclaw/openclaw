import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createDeliveryRecoveryCoordinator,
  isDeliveryRecoveryRetryEligible,
  isRetryableDeliveryNotSentError,
  resolveDeliveryNotSentRetryability,
  resolveDeliveryRecoveryDeadlineMs,
} from "./delivery-recovery.shared.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "./outbound/deliver-types.js";

type RecoveryTestEntry = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  availableAt?: number;
};

function createEntry(id: string, enqueuedAt: number): RecoveryTestEntry {
  return { id, enqueuedAt, retryCount: 0 };
}

describe("typed no-send retryability", () => {
  const retryableMarker = () =>
    new PlatformMessageNotDispatchedError("Outbound not configured for channel: proof", {
      cause: new Error("adapter unavailable"),
    });

  const permanentMarker = () =>
    new PlatformMessageNotDispatchedError("chat not found", {
      cause: new Error("invalid recipient"),
      retryable: false,
    });

  it.each([
    { name: "retryable marker", error: retryableMarker, typed: true, retryable: true },
    { name: "permanent marker", error: permanentMarker, typed: false, retryable: false },
    {
      name: "untyped pre-connect failure",
      error: () =>
        Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      typed: undefined,
      retryable: true,
    },
    {
      name: "unproven failure",
      error: () => new Error("chat not found"),
      typed: undefined,
      retryable: false,
    },
    ...(["connect", "read"] as const).map((syscall) => ({
      name: `grammY-wrapped dual-stack ${syscall} timeout`,
      error: () =>
        Object.assign(new Error("Network request for 'sendMessage' failed!"), {
          name: "HttpError",
          error: new TypeError("fetch failed", {
            cause: Object.assign(
              new AggregateError([
                Object.assign(new Error("IPv6 route unavailable"), {
                  code: "ENETUNREACH",
                  syscall: "connect",
                }),
                Object.assign(new Error("IPv4 timed out"), { code: "ETIMEDOUT", syscall }),
              ]),
              { code: "ETIMEDOUT" },
            ),
          }),
        }),
      typed: undefined,
      retryable: syscall === "connect",
    })),
    {
      name: "mixed retryable and permanent markers",
      error: () => new AggregateError([retryableMarker(), permanentMarker()]),
      typed: false,
      retryable: false,
    },
    {
      name: "delivery with an already-dispatched result",
      error: () =>
        new OutboundDeliveryError("delivery failed after dispatch", {
          cause: retryableMarker(),
          results: [{ channel: "telegram", messageId: "sent" }],
        }),
      typed: undefined,
      retryable: false,
    },
    {
      name: "marker with contradictory visible-send evidence",
      error: () => Object.assign(retryableMarker(), { visibleReplySent: true }),
      typed: undefined,
      retryable: false,
    },
  ])("preserves typed and fallback retry policy for $name", ({ error, typed, retryable }) => {
    const failure = error();
    expect(resolveDeliveryNotSentRetryability(failure)).toBe(typed);
    expect(isRetryableDeliveryNotSentError(failure)).toBe(retryable);
  });
});

describe("shared durable delivery recovery coordinator", () => {
  it("recovers independent domains while keeping each domain's attempts sequential", async () => {
    vi.useFakeTimers();
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>({
      maxConcurrentLanes: 2,
    });
    const entries = [createEntry("a-first", 1), createEntry("a-next", 2), createEntry("b", 3)];
    const started: string[] = [];
    const scan = coordinator.scan({
      entries,
      laneKey: (entry) => entry.id.slice(0, 1),
      loadEntry: async (id) => entries.find((entry) => entry.id === id) ?? null,
      onEntry: async (entry) => {
        started.push(entry.id);
        if (entry.id === "a-first") {
          await new Promise((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([...started]).toEqual(["a-first", "b"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await scan;
      expect(started).toEqual(["a-first", "b", "a-next"]);
    } finally {
      await vi.runAllTimersAsync();
      await scan;
      vi.useRealTimers();
    }
  });

  it("shares lane ownership and capacity across competing scans without consuming busy work", async () => {
    vi.useFakeTimers();
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>({
      maxConcurrentLanes: 2,
    });
    const entries = [createEntry("a", 1), createEntry("b", 2), createEntry("c", 3)];
    const started: string[] = [];
    const scanOptions = {
      laneKey: (entry: RecoveryTestEntry) => entry.id,
      loadEntry: async (id: string) => entries.find((entry) => entry.id === id) ?? null,
      onEntry: async (entry: RecoveryTestEntry) => {
        started.push(entry.id);
        await new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        });
      },
    };
    const first = coordinator.scan({ ...scanOptions, entries: entries.slice(0, 2) });
    let second: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      second = coordinator.scan({ ...scanOptions, entries });
      await vi.advanceTimersByTimeAsync(0);
      expect([...started]).toEqual(["a", "b"]);
      await second;
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      const next = coordinator.scan({ ...scanOptions, entries: entries.slice(2) });
      await vi.advanceTimersByTimeAsync(1_000);
      await next;
      expect(started).toEqual(["a", "b", "c"]);
    } finally {
      await vi.runAllTimersAsync();
      await Promise.all([first, second]);
      vi.useRealTimers();
    }
  });

  it("joins admitted domains after failure and does not start their successors", async () => {
    vi.useFakeTimers();
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>({
      maxConcurrentLanes: 2,
    });
    const entries = [createEntry("a", 1), createEntry("b", 2), createEntry("b-next", 3)];
    const started: string[] = [];
    let settled = false;
    const scan = coordinator
      .scan({
        entries,
        laneKey: (entry) => entry.id.slice(0, 1),
        loadEntry: async (id) => entries.find((entry) => entry.id === id) ?? null,
        onEntry: async (entry) => {
          started.push(entry.id);
          await new Promise((resolve) => {
            setTimeout(resolve, entry.id === "a" ? 10 : 1_000);
          });
          if (entry.id === "a") {
            throw new Error("owner read failed");
          }
        },
      })
      .then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(started).toEqual(["a", "b"]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await scan).toEqual(new Error("owner read failed"));
      expect(started).toEqual(["a", "b"]);
    } finally {
      await vi.runAllTimersAsync();
      await scan;
      vi.useRealTimers();
    }
  });

  it("shares active claims between live delivery and recovery scans", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const entry = createEntry("live-owner", 1);
    const loadEntry = vi.fn(async () => entry);
    const onEntry = vi.fn(async () => undefined);
    const onClaimConflict = vi.fn();
    const { promise: liveGate, resolve: releaseLiveDelivery } = createDeferred();
    const liveDelivery = coordinator.withClaim(entry.id, () => liveGate);

    await coordinator.scan({ entries: [entry], loadEntry, onEntry, onClaimConflict });

    expect(onClaimConflict).toHaveBeenCalledWith(entry);
    expect(loadEntry).not.toHaveBeenCalled();
    expect(onEntry).not.toHaveBeenCalled();

    releaseLiveDelivery();
    await expect(liveDelivery).resolves.toEqual({ status: "claimed", value: undefined });
    await coordinator.scan({ entries: [entry], loadEntry, onEntry });
    expect(onEntry).toHaveBeenCalledWith(entry);
  });

  it("releases an active claim when its owner throws", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();

    await expect(
      coordinator.withClaim("failed-owner", async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    await expect(coordinator.withClaim("failed-owner", async () => "recovered")).resolves.toEqual({
      status: "claimed",
      value: "recovered",
    });
  });

  it("excludes concurrent same-key drains and releases failed drains", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const { promise: drainGate, resolve: releaseDrain } = createDeferred();
    const first = coordinator.withDrain("account:demo", () => drainGate);

    await expect(coordinator.withDrain("account:demo", async () => undefined)).resolves.toBe(false);
    releaseDrain();
    await expect(first).resolves.toBe(true);

    await expect(
      coordinator.withDrain("account:demo", async () => {
        throw new Error("scan interrupted");
      }),
    ).rejects.toThrow("scan interrupted");
    await expect(coordinator.withDrain("account:demo", async () => undefined)).resolves.toBe(true);
  });

  it("sorts snapshots and reloads authoritative entries before processing", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const first = createEntry("first", 1);
    const missing = createEntry("missing", 2);
    const last = createEntry("last", 3);
    const authoritativeFirst = { ...first, retryCount: 2 };
    const pending = new Map([
      [first.id, authoritativeFirst],
      [last.id, last],
    ]);
    const processed: RecoveryTestEntry[] = [];
    const onMissingEntry = vi.fn();

    await coordinator.scan({
      entries: [last, missing, first],
      loadEntry: async (id) => pending.get(id) ?? null,
      onMissingEntry,
      onEntry: async (entry) => {
        processed.push(entry);
      },
    });

    expect(processed).toEqual([authoritativeFirst, last]);
    expect(onMissingEntry).toHaveBeenCalledWith(missing);
  });

  it("stops after an owner reports that its replay budget was exhausted", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const entries = [createEntry("first", 1), createEntry("remaining", 2)];
    const onEntry = vi.fn(async () => "stop" as const);

    await coordinator.scan({
      entries,
      loadEntry: async (id) => entries.find((entry) => entry.id === id) ?? null,
      onEntry,
    });

    expect(onEntry).toHaveBeenCalledTimes(1);
    expect(onEntry).toHaveBeenCalledWith(entries[0]);
  });

  it("defers expired recovery without claiming or reloading a pending entry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
      const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
      const entry = createEntry("deadline", Date.now());
      const loadEntry = vi.fn(async () => entry);
      const onEntry = vi.fn(async () => undefined);
      const onDeadlineExceeded = vi.fn();

      await coordinator.scan({
        entries: [entry],
        loadEntry,
        onEntry,
        deadlineMs: Date.now(),
        onDeadlineExceeded,
      });

      expect(onDeadlineExceeded).toHaveBeenCalledOnce();
      expect(loadEntry).not.toHaveBeenCalled();
      expect(onEntry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors initial delivery leases and canonical retry backoff", () => {
    const now = 100_000;
    expect(
      isDeliveryRecoveryRetryEligible(
        { ...createEntry("leased", now), availableAt: now + 250 },
        now,
      ),
    ).toEqual({ eligible: false, remainingBackoffMs: 250 });
    expect(isDeliveryRecoveryRetryEligible(createEntry("fresh", now), now)).toEqual({
      eligible: true,
    });
    expect(
      isDeliveryRecoveryRetryEligible(
        { ...createEntry("retry", now - 2_000), retryCount: 1, lastAttemptAt: now - 2_000 },
        now,
      ),
    ).toEqual({ eligible: false, remainingBackoffMs: 3_000 });
  });

  it("normalizes recovery deadlines without widening negative or invalid budgets", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
      const now = Date.now();
      expect(resolveDeliveryRecoveryDeadlineMs(-1)).toBe(now);
      expect(resolveDeliveryRecoveryDeadlineMs(5_000.9)).toBe(now + 5_000);
      expect(resolveDeliveryRecoveryDeadlineMs(Number.NaN)).toBe(now + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
