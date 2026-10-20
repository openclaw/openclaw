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
vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  createOpenClawStateLeaseWorkerStorage: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  prepareLeaseDatabase: fixture.forbiddenNative,
  resolveLeaseDatabasePath: () => "/synthetic-state/lease.sqlite",
  verifyOpenClawStateLeaseOwnership: () => fixture.expiresAt,
  renewOpenClawStateLease: () => {
    if (fixture.loseRenewal) {
      throw new OpenClawStateLeaseError("Synthetic lease ownership was lost", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
    }
    fixture.expiresAt = Date.now() + 30_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseBestEffort: async () => fixture.release(),
  releaseOpenClawStateLease: fixture.release,
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

function loseLease(lease: OpenClawStateLeaseContext): unknown {
  fixture.loseRenewal = true;
  // Drive the real native owner's renewal callback against the fake store.
  vi.advanceTimersByTime(10_000);
  expect(lease.signal.aborted).toBe(true);
  expect(lease.signal.reason).toBeInstanceOf(OpenClawStateLeaseError);
  expect(lease.signal.reason).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  return lease.signal.reason;
}

async function failUnderAuthority(
  failure: unknown,
  authority: "none" | "loss" | "abort" | "loss and abort" = "none",
) {
  const caller = new AbortController();
  const abortCause = new Error("Caller canceled the outer operation");
  let loss: unknown;
  const error: unknown = await withOpenClawStateLease(
    {
      scope: "core:test",
      key: "nested-uncertainty",
      database: { scope: "shared", options: { path: "/synthetic-state/lease.sqlite" } },
      leaseMs: 30_000,
      waitMs: 0,
      signal: authority === "none" ? undefined : caller.signal,
    },
    async (lease) => {
      if (authority === "loss" || authority === "loss and abort") {
        loss = loseLease(lease);
      }
      if (authority === "abort" || authority === "loss and abort") {
        caller.abort(abortCause);
        expect(caller.signal.aborted).toBe(true);
      }
      throw failure;
    },
  ).then(
    () => {
      throw new Error("Lease operation unexpectedly succeeded");
    },
    (reason: unknown) => reason,
  );
  expect(fixture.release).toHaveBeenCalledOnce();
  return { error, loss, abortCause };
}

it("preserves a direct unknown failure by identity without outer authority loss", async () => {
  const failure = new SqliteWorkerError("Nested write outcome is unknown", "outcome-unknown");
  expect((await failUnderAuthority(failure)).error).toBe(failure);
});

it("normalizes a structured unknown marker without losing its cause", async () => {
  const failure = { code: "outcome-unknown", message: "Nested write outcome is unknown" };
  const { error } = await failUnderAuthority(failure);
  expect(error).toBeInstanceOf(SqliteWorkerError);
  expect(error).toMatchObject({ code: "outcome-unknown", cause: failure });
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
    const { error, loss, abortCause } = await failUnderAuthority(failure, authority);
    expect(error).toMatchObject({ code: "outcome-unknown" });
    const causes = collectNestedErrorCandidates(error);
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
  },
);

it.each(["none", "loss", "abort"] as const)(
  "keeps known failure mapping and release unchanged with %s authority",
  async (authority) => {
    const failure = new Error("Known operation failure");
    const { error, loss, abortCause } = await failUnderAuthority(failure, authority);
    if (authority === "none") {
      expect(error).toBe(failure);
    } else if (authority === "loss") {
      expect(error).toBe(loss);
    } else {
      expect(error).toMatchObject({
        code: "OPENCLAW_STATE_LEASE_ABORTED",
        cause: abortCause,
      });
    }
  },
);
