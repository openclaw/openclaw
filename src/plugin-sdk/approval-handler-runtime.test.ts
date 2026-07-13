import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../infra/exec-approvals.js";
import {
  buildChannelApprovalResolvedText,
  type ExecApprovalResolvedView,
} from "./approval-handler-runtime.js";
import * as approvalRenderers from "./approval-renderers.js";

function makeExecRequest(id: string): ExecApprovalRequest {
  return {
    id,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "echo hi",
      turnSourceChannel: "test",
      turnSourceTo: "origin-chat",
    },
  };
}

function makeExecResolved(decision: ExecApprovalResolved["decision"]): ExecApprovalResolved {
  return {
    id: "resolved-id",
    decision,
    ts: Date.now(),
  };
}

function makeExecResolvedView(
  decision: ExecApprovalResolved["decision"],
): ExecApprovalResolvedView {
  return {
    approvalId: "resolved-id",
    approvalKind: "exec",
    phase: "resolved",
    title: "Exec approval",
    commandText: "echo hi",
    metadata: [],
    decision,
  };
}

describe("approval-handler-runtime/buildChannelApprovalResolvedText", () => {
  it("does not split surrogate pairs in the resolved exec approval slug", () => {
    const spy = vi.spyOn(approvalRenderers, "buildApprovalResolvedReplyPayload");
    const surrogateBoundaryId = "1234567😀890";

    buildChannelApprovalResolvedText({
      request: makeExecRequest(surrogateBoundaryId),
      resolved: makeExecResolved("allow-once"),
      view: makeExecResolvedView("allow-once"),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const approvalSlug = spy.mock.calls[0]?.[0].approvalSlug;
    expect(approvalSlug).toBe("1234567");
    expect(() => encodeURIComponent(String(approvalSlug))).not.toThrow();

    spy.mockRestore();
  });
});
