import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  LEASE_CONTENTION_RETRY_TIMEOUT_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";
import * as leaseStorage from "./openclaw-state-lease-storage.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn,
    }),
  };
});

const leaseMs = 30_000;
const heartbeatMs = 10_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  warn.mockClear();
  closeOpenClawStateDatabaseForTest();
});

async function withNativeLeaseTest(
  run: (test: {
    writer: DatabaseSync;
    readExpiry: () => number;
    runLease: (
      callback: (lease: OpenClawStateLeaseContext) => Promise<void>,
      signal?: AbortSignal,
    ) => Promise<void>;
  }) => Promise<void>,
  durationMs = leaseMs,
) {
  await withOpenClawTestState({ label: "native-lease-renewal" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const writer = new DatabaseSync(database.path);
    try {
      vi.useFakeTimers();
      await run({
        writer,
        readExpiry: () =>
          Number(
            database.db
              .prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
              .get("core:test", "native-renewal")?.expires_at,
          ),
        runLease: (callback, signal) =>
          withOpenClawStateLease(
            {
              scope: "core:test",
              key: "native-renewal",
              leaseMs: durationMs,
              waitMs: 0,
              signal,
              database: { scope: "shared", options: { env: state.env } },
            },
            callback,
          ),
      });
    } finally {
      writer.close();
    }
  });
}

it("paces long leases by their TTL without periodic short-interval writes", async () => {
  await withNativeLeaseTest(async ({ readExpiry, runLease }) => {
    await runLease(async (lease) => {
      let expiresAt = readExpiry();
      for (let renewal = 1; renewal <= 3; renewal++) {
        await vi.advanceTimersByTimeAsync(99_999);
        expect(readExpiry()).toBe(expiresAt);
        await vi.advanceTimersByTimeAsync(1);
        expect(readExpiry()).toBeGreaterThan(expiresAt);
        expiresAt = readExpiry();
        expect(lease.signal.aborted).toBe(false);
      }
    });
  }, 300_000);
});

it.each([false, true])(
  "renews a native lease after its heartbeat (contended=%s)",
  async (contended) => {
    await withNativeLeaseTest(async ({ writer, readExpiry, runLease }) => {
      await runLease(async (lease) => {
        const initialExpiry = readExpiry();
        if (contended) {
          writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        }
        try {
          await vi.advanceTimersByTimeAsync(heartbeatMs);
        } finally {
          if (contended) {
            writer.exec("ROLLBACK");
          }
        }
        await vi.advanceTimersByTimeAsync(LEASE_CONTENTION_RETRY_MS);
        expect(readExpiry()).toBeGreaterThan(initialExpiry);
        expect(lease.signal.aborted).toBe(false);
      });
      expect(warn).toHaveBeenCalledTimes(contended ? 2 : 0);
    });
  },
);

it("bounds a contended retry burst and leaves the regular heartbeat available", async () => {
  await withNativeLeaseTest(async ({ writer, readExpiry, runLease }) => {
    const renew = vi.spyOn(leaseStorage, "renewOpenClawStateLease");
    await runLease(async () => {
      const initialExpiry = readExpiry();
      writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      try {
        await vi.advanceTimersByTimeAsync(heartbeatMs + LEASE_CONTENTION_RETRY_TIMEOUT_MS);
        const attempts = renew.mock.calls.length;
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThanOrEqual(
          1 + LEASE_CONTENTION_RETRY_TIMEOUT_MS / LEASE_CONTENTION_RETRY_MS,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(renew).toHaveBeenCalledTimes(attempts);
      } finally {
        writer.exec("ROLLBACK");
      }
      expect(readExpiry()).toBe(initialExpiry);
      await vi.advanceTimersByTimeAsync(heartbeatMs - LEASE_CONTENTION_RETRY_TIMEOUT_MS - 1_000);
      expect(readExpiry()).toBeGreaterThan(initialExpiry);
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

it.each(["release", "abort"] as const)("cancels a pending retry on %s", async (ending) => {
  await withNativeLeaseTest(async ({ writer, runLease }) => {
    const renew = vi.spyOn(leaseStorage, "renewOpenClawStateLease");
    const controller = new AbortController();
    const operation = runLease(async () => {
      writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      try {
        await vi.advanceTimersByTimeAsync(heartbeatMs);
      } finally {
        writer.exec("ROLLBACK");
      }
      if (ending === "abort") {
        controller.abort();
        await vi.advanceTimersByTimeAsync(LEASE_CONTENTION_RETRY_MS);
        expect(renew).toHaveBeenCalledTimes(1);
      }
    }, controller.signal);
    if (ending === "abort") {
      await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    } else {
      await operation;
    }
    await vi.advanceTimersByTimeAsync(heartbeatMs);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});

it.each(["expired", "replaced"] as const)("never revives an %s owner on retry", async (loss) => {
  await withNativeLeaseTest(async ({ writer, readExpiry, runLease }) => {
    let originalExpiry = 0;
    await expect(
      runLease(async () => {
        originalExpiry = readExpiry();
        writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        try {
          await vi.advanceTimersByTimeAsync(heartbeatMs);
        } finally {
          writer.exec("ROLLBACK");
        }
        if (loss === "expired") {
          vi.setSystemTime(originalExpiry + 1);
        } else {
          writer.exec("UPDATE state_leases SET owner = 'replacement'");
        }
        await vi.advanceTimersByTimeAsync(LEASE_CONTENTION_RETRY_MS);
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    if (loss === "replaced") {
      expect(readExpiry()).toBe(originalExpiry);
      expect(writer.prepare("SELECT owner FROM state_leases").get()?.owner).toBe("replacement");
    }
  });
});

it("reports unexpected renewal failures once without logging their messages or retrying them", async () => {
  await withNativeLeaseTest(async ({ writer, runLease }) => {
    const renew = vi.spyOn(leaseStorage, "renewOpenClawStateLease");
    await runLease(async () => {
      writer.exec(
        "CREATE TRIGGER fail_renewal BEFORE UPDATE ON state_leases BEGIN SELECT RAISE(ABORT, 'private-renewal-content'); END",
      );
      try {
        await vi.advanceTimersByTimeAsync(heartbeatMs + LEASE_CONTENTION_RETRY_TIMEOUT_MS);
        expect(renew).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(heartbeatMs - LEASE_CONTENTION_RETRY_TIMEOUT_MS);
        expect(renew).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        writer.exec("DROP TRIGGER fail_renewal");
      }
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-renewal-content");
  });
});
