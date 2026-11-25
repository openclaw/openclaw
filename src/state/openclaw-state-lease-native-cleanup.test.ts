import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { createOpenClawStateLeaseLostError } from "./openclaw-state-lease-error.js";
import type { acquireLease } from "./openclaw-state-lease-worker-storage.js";
import { withOpenClawStateLease as withLease } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const options = {
  scope: "core:plugin-lifecycle",
  key: "global",
  database: { scope: "shared" as const },
  leaseMs: 60_000,
  waitMs: 0,
};
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
  async acquireLease(...args: Parameters<typeof acquireLease>) {
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
    const captureSource = args[4] ?? storage.forbidden;
    captureSource({ context, identity: context.admission.identity });
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
  createOpenClawStateLeaseLostErrorFromDatabase: (
    identity: Parameters<typeof createOpenClawStateLeaseLostError>[0],
    _database: unknown,
    cause?: unknown,
  ) => createOpenClawStateLeaseLostError(identity, cause),
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
  storage.remainingMs = -1;
  const entered = vi.fn();
  await expect(withLease(options, entered)).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_LOST",
  });
  expect(entered).not.toHaveBeenCalled();
  storage.remainingMs = 60_000;
  await expect(withLease(options, async () => "recovered")).resolves.toBe("recovered");
});

it("releases a failed native lease cleanup when the shared resource owner closes", async () => {
  const processOptions = { ...options, processBound: true };
  await expect(
    withLease(processOptions, async () => {
      await closeOpenClawStateDatabaseAsync();
      storage.unavailable = true;
      throw new Error("Synthetic operation lost maintenance admission");
    }),
  ).rejects.toThrow("State lease operation and cleanup failed");
  storage.unavailable = false;
  await closeOpenClawStateDatabaseAsync();
  await expect(withLease(processOptions, async () => "recovered")).resolves.toBe("recovered");
});
