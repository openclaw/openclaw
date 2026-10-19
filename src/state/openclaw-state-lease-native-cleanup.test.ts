import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const storage = vi.hoisted(() => ({
  held: false,
  unavailable: false,
  expiresAt: 0,
  remainingMs: 60_000,
  forbidden: vi.fn(() => {
    throw new Error("Controlled cleanup proof must not open SQLite");
  }),
}));

// mock-isolation: Any real SQLite open must fail this controlled-storage cleanup proof.
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: storage.forbidden,
}));
// mock-isolation: Control storage failures while exercising the real lease and canonical-close owners.
vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  async acquireLease(
    _database: unknown,
    _input: unknown,
    _assertCurrent: unknown,
    _signal: unknown,
    captureSource: (
      context: OpenClawStateWorkerContext,
      identity: OpenClawStateWorkerContext["admission"]["identity"],
    ) => void,
  ) {
    if (storage.held) {
      return {
        kind: "held",
        holder: { owner: "original-owner", epoch: 1, expiresAt: storage.expiresAt },
      };
    }
    const context: OpenClawStateWorkerContext = {
      environment: { OPENCLAW_STATE_DIR: "/synthetic-state" },
      admission: {
        coordinationKey: "file:synthetic-native-cleanup",
        databasePath: "/synthetic-state/lease.sqlite",
        identity: {
          key: "file:synthetic-native-cleanup",
          canonicalPath: "/synthetic-state/lease.sqlite",
        },
        assertCurrent() {},
      },
    };
    captureSource(context, context.admission.identity);
    storage.held = true;
    storage.expiresAt = Date.now() + storage.remainingMs;
    return { kind: "acquired", expiresAt: storage.expiresAt };
  },
  createOpenClawStateLeaseWorkerStorage: () => ({
    async release() {
      if (storage.unavailable) {
        throw new Error("Synthetic maintenance blocks lease cleanup");
      }
      storage.held = false;
    },
  }),
}));
// mock-isolation: Keep cleanup failure deterministic and forbid native database access.
vi.mock("./openclaw-state-lease-storage.js", () => ({
  STATE_LEASE_WRITE_BACKOFF: { initialMs: 25, maxMs: 250, factor: 1.5, jitter: 0.25 },
  prepareLeaseDatabase: storage.forbidden,
  resolveLeaseDatabasePath: () => "/synthetic-state/lease.sqlite",
  verifyOpenClawStateLeaseOwnership: () => storage.expiresAt,
  renewOpenClawStateLease: () => storage.expiresAt,
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) =>
    execute?.(),
  releaseOpenClawStateLease: storage.forbidden,
}));

afterEach(async () => {
  storage.unavailable = false;
  storage.remainingMs = 60_000;
  await closeOpenClawStateDatabaseAsync();
  storage.held = false;
  expect(storage.forbidden).not.toHaveBeenCalled();
});

it("releases a native acquisition that expires before callback entry", async () => {
  const options = {
    scope: "core:plugin-lifecycle",
    key: "expired-startup",
    database: { scope: "shared" as const },
    leaseMs: 60_000,
    waitMs: 0,
  };
  storage.remainingMs = -1;
  const entered = vi.fn();
  await expect(withOpenClawStateLease(options, entered)).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_LOST",
  });
  expect(entered).not.toHaveBeenCalled();
  storage.remainingMs = 60_000;
  await expect(withOpenClawStateLease(options, async () => "recovered")).resolves.toBe("recovered");
});

it("releases a failed native lease cleanup when the shared resource owner closes", async () => {
  const options = {
    scope: "core:plugin-lifecycle",
    key: "global",
    database: { scope: "shared" as const },
    leaseMs: 60_000,
    waitMs: 0,
    processBound: true,
  };
  await expect(
    withOpenClawStateLease(options, async () => {
      await closeOpenClawStateDatabaseAsync();
      storage.unavailable = true;
      throw new Error("Synthetic operation lost maintenance admission");
    }),
  ).rejects.toThrow("State lease operation and cleanup failed");
  storage.unavailable = false;
  await closeOpenClawStateDatabaseAsync();
  await expect(withOpenClawStateLease(options, async () => "recovered")).resolves.toBe("recovered");
});
