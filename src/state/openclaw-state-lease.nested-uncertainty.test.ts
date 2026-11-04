import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
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
        fixture.loseRenewal = true;
        // Drive the real owner's renewal callback against the fake store.
        vi.advanceTimersByTime(10_000);
        expect(lease.signal.aborted).toBe(true);
        loss = lease.signal.reason;
        expect(loss).toBeInstanceOf(OpenClawStateLeaseError);
        expect(loss).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      }
      if (authority === "abort" || authority === "loss and abort") {
        caller.abort(abortCause);
        expect(caller.signal.aborted).toBe(true);
      }
      throw failure;
    },
  ).then(
    () => assert.fail("Lease operation unexpectedly succeeded"),
    (reason: unknown) => reason,
  );
  expect(fixture.release).toHaveBeenCalledOnce();
  return { error, loss, abortCause };
}

it.each([
  { shape: "direct", authority: "none" },
  { shape: "structured", authority: "none" },
  { shape: "direct", authority: "loss" },
  { shape: "cause", authority: "abort" },
  { shape: "aggregate", authority: "loss and abort" },
  { shape: "known", authority: "none" },
  { shape: "known", authority: "loss" },
  { shape: "known", authority: "abort" },
] as const)("preserves $shape failure under $authority authority", async ({ shape, authority }) => {
  const unknown = new SqliteWorkerError("Nested write outcome is unknown", "outcome-unknown");
  const sibling = new Error("Sibling cleanup failed");
  const failure = {
    known: new Error("Known failure"),
    structured: { code: "outcome-unknown", message: "Unknown outcome" },
    cause: new Error("Nested failure", { cause: unknown }),
    aggregate: new AggregateError([sibling, unknown], "Nested failures"),
    direct: unknown,
  }[shape];
  const { error, loss, abortCause } = await failUnderAuthority(failure, authority);
  if (shape === "known") {
    if (authority === "abort") {
      expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED", cause: abortCause });
    } else {
      expect(error).toBe(authority === "loss" ? loss : failure);
    }
    return;
  }
  expect(error).toMatchObject({ code: "outcome-unknown" });
  if (shape === "structured") {
    expect(error).toBeInstanceOf(SqliteWorkerError);
    expect(error).toMatchObject({ cause: failure });
  } else if (authority === "none") {
    expect(error).toBe(failure);
  } else {
    const causes = collectNestedErrorCandidates(error);
    for (const cause of [unknown, failure, ...(shape === "aggregate" ? [sibling] : [])]) {
      expect(causes).toContain(cause);
    }
    if (authority === "abort") {
      expect(causes).toContain(abortCause);
      expect(causes).toContainEqual(
        expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_ABORTED", cause: abortCause }),
      );
    } else {
      // Lease loss takes precedence when both authorities fire.
      expect(causes).toContain(loss);
    }
  }
});
