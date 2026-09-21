import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError, withOpenClawStateLease } from "./openclaw-state-lease.js";

const fixture = vi.hoisted(() => ({
  expiresAt: 40_000,
  loseRenewal: false,
  release: vi.fn(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Nested uncertainty controls must not open SQLite or heartbeat workers");
  }),
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  prepareLeaseDatabase: fixture.forbiddenNative,
  resolveLeaseDatabasePath: () => "/synthetic-state/lease.sqlite",
  readLeaseDatabase: (_database: unknown, run: () => unknown) => run(),
  withLeaseWriteTransaction: (_database: unknown, _label: string, run: () => unknown) => run(),
}));
vi.mock("./openclaw-state-lease-store.js", () => ({
  readOpenClawStateLeaseExpiry: () =>
    Date.now() < fixture.expiresAt ? fixture.expiresAt : undefined,
  renewOpenClawStateLeaseInTransaction: () => {
    if (fixture.loseRenewal) {
      return undefined;
    }
    fixture.expiresAt = Date.now() + 30_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseInTransaction: fixture.release,
}));
vi.mock("./openclaw-state-lease-exclusion.js", () => ({
  createOpenClawStateLeaseExclusion: () => ({
    canRelease: () => true,
    assertIfExcluded: () => false,
    runWithOwnerScope: (run: () => Promise<unknown>) => run(),
    drain: async () => {},
  }),
}));
vi.mock("./openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: fixture.forbiddenNative,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.expiresAt = 40_000;
  fixture.loseRenewal = false;
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  try {
    expect(fixture.forbiddenNative).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

function runLease(run: (lease: OpenClawStateLeaseContext) => Promise<never>, signal?: AbortSignal) {
  return withOpenClawStateLease(
    {
      scope: "core:test",
      key: "nested-uncertainty",
      database: { scope: "shared", options: { path: "/synthetic-state/lease.sqlite" } },
      leaseMs: 30_000,
      waitMs: 0,
      signal,
    },
    run,
  );
}

function loseLease(lease: OpenClawStateLeaseContext): unknown {
  fixture.loseRenewal = true;
  // Drive the real native owner's renewal callback against the fake store.
  vi.advanceTimersByTime(10_000);
  expect(lease.signal.aborted).toBe(true);
  expect(lease.signal.reason).toBeInstanceOf(OpenClawStateLeaseError);
  expect(lease.signal.reason).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  return lease.signal.reason;
}

it("preserves a direct unknown failure by identity without outer authority loss", async () => {
  const failure = new SqliteWorkerError("Nested write outcome is unknown", "outcome-unknown");
  await expect(
    runLease(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(fixture.release).toHaveBeenCalledOnce();
});

it("normalizes a structured unknown marker without losing its cause", async () => {
  const failure = { code: "outcome-unknown", message: "Nested write outcome is unknown" };
  const operation = runLease(vi.fn<() => Promise<never>>().mockRejectedValue(failure));
  await expect(operation).rejects.toBeInstanceOf(SqliteWorkerError);
  await expect(operation).rejects.toMatchObject({ code: "outcome-unknown", cause: failure });
  expect(fixture.release).toHaveBeenCalledOnce();
});

it.each([
  { shape: "direct", authority: "loss" },
  { shape: "cause", authority: "abort" },
  { shape: "aggregate", authority: "loss and abort" },
] as const)(
  "preserves $shape uncertainty across outer $authority",
  async ({ shape, authority }) => {
    const unknown = new SqliteWorkerError("Nested write outcome is unknown", "outcome-unknown");
    const sibling = new Error("Sibling cleanup failed");
    const failure =
      shape === "direct"
        ? unknown
        : shape === "cause"
          ? new Error("Nested operation failed", { cause: unknown })
          : new AggregateError([sibling, unknown], "Nested failures");
    const caller = new AbortController();
    const abortCause = new Error("Caller canceled the outer operation");
    let loss: unknown;
    const operation = runLease(async (lease) => {
      if (authority !== "abort") {
        loss = loseLease(lease);
      }
      if (authority !== "loss") {
        caller.abort(abortCause);
        expect(caller.signal.aborted).toBe(true);
      }
      throw failure;
    }, caller.signal);
    const [outcome] = await Promise.allSettled([operation]);
    if (outcome.status !== "rejected") {
      throw new Error("Nested uncertainty unexpectedly succeeded");
    }
    expect(outcome.reason).toMatchObject({ code: "outcome-unknown" });
    const causes = collectNestedErrorCandidates(outcome.reason);
    expect(causes).toContain(unknown);
    expect(causes).toContain(failure);
    if (shape === "aggregate") {
      expect(causes).toContain(sibling);
    }
    if (authority === "abort") {
      expect(causes).toContain(abortCause);
      expect(causes).toContainEqual(
        expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_ABORTED", cause: abortCause }),
      );
    } else {
      // Existing authority precedence selects lease loss when both signals have fired.
      expect(causes).toContain(loss);
    }
    // Constructed nested uncertainty does not create an unknown settlement on this owner.
    expect(fixture.release).toHaveBeenCalledOnce();
  },
);

it.each(["none", "loss", "abort"] as const)(
  "keeps known failure mapping and release unchanged with %s authority",
  async (authority) => {
    const failure = new Error("Known operation failure");
    const abortCause = new Error("Caller canceled the known failure");
    const caller = new AbortController();
    let loss: unknown;
    const operation = runLease(async (lease) => {
      if (authority === "loss") {
        loss = loseLease(lease);
      } else if (authority === "abort") {
        caller.abort(abortCause);
      }
      throw failure;
    }, caller.signal);
    const [outcome] = await Promise.allSettled([operation]);
    if (outcome.status !== "rejected") {
      throw new Error("Known failure unexpectedly succeeded");
    }
    if (authority === "none") {
      expect(outcome.reason).toBe(failure);
    } else if (authority === "loss") {
      expect(outcome.reason).toBe(loss);
    } else {
      expect(outcome.reason).toMatchObject({
        code: "OPENCLAW_STATE_LEASE_ABORTED",
        cause: abortCause,
      });
    }
    expect(fixture.release).toHaveBeenCalledOnce();
  },
);
