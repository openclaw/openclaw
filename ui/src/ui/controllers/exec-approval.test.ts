import { describe, expect, it } from "vitest";
import {
  isExecApprovalExpired,
  parseExecApprovalExpired,
  resolveExecApprovalDecisionTarget,
  type ExecApprovalRequest,
} from "./exec-approval.ts";

function createRequest(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: {
      command: "echo hello",
      host: "gateway",
    },
    createdAtMs: 1_000,
    expiresAtMs: 11_000,
    ...overrides,
  };
}

describe("parseExecApprovalExpired", () => {
  it("parses expired payloads that include an id", () => {
    expect(parseExecApprovalExpired({ id: "approval-1", ts: 2_000 })).toEqual({
      id: "approval-1",
      ts: 2_000,
    });
  });

  it("rejects expired payloads without an id", () => {
    expect(parseExecApprovalExpired({ ts: 2_000 })).toBeNull();
  });
});

describe("isExecApprovalExpired", () => {
  it("treats approvals at or before now as expired", () => {
    expect(isExecApprovalExpired(createRequest({ expiresAtMs: 5_000 }), 5_000)).toBe(true);
    expect(isExecApprovalExpired(createRequest({ expiresAtMs: 4_999 }), 5_000)).toBe(true);
    expect(isExecApprovalExpired(createRequest({ expiresAtMs: 5_001 }), 5_000)).toBe(false);
  });
});

describe("resolveExecApprovalDecisionTarget", () => {
  it("resolves the clicked approval by id instead of relying on queue position", () => {
    const first = createRequest({ id: "approval-1", expiresAtMs: 9_000 });
    const second = createRequest({ id: "approval-2", expiresAtMs: 10_000 });

    expect(resolveExecApprovalDecisionTarget([first, second], "approval-2", 2_000)).toEqual({
      kind: "ready",
      entry: second,
      queue: [first, second],
    });
  });

  it("returns expired and prunes the queue when the clicked approval has timed out", () => {
    const expired = createRequest({ id: "expired", expiresAtMs: 4_000 });
    const active = createRequest({ id: "active", expiresAtMs: 8_000 });

    expect(resolveExecApprovalDecisionTarget([expired, active], "expired", 5_000)).toEqual({
      kind: "expired",
      queue: [active],
    });
  });

  it("returns missing while still pruning unrelated expired approvals", () => {
    const expired = createRequest({ id: "expired", expiresAtMs: 4_000 });
    const active = createRequest({ id: "active", expiresAtMs: 8_000 });

    expect(resolveExecApprovalDecisionTarget([expired, active], "missing", 5_000)).toEqual({
      kind: "missing",
      queue: [active],
    });
  });
});
