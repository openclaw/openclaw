/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

type TestApproval = {
  id: string;
  kind: "exec";
  title: string;
  summary: string;
  createdAtMs: number;
  expiresAtMs: number;
};

type ExecApprovalApp = {
  client: { request: ReturnType<typeof vi.fn> } | null;
  execApprovalQueue: TestApproval[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
};

function createApproval(id: string): TestApproval {
  return {
    id,
    kind: "exec",
    title: "Approve command",
    summary: "printf test",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

async function runDecision(app: ExecApprovalApp, decision: "allow-once" | "allow-always" | "deny") {
  const { OpenClawApp } = await import("./app.ts");
  await OpenClawApp.prototype.handleExecApprovalDecision.call(app as never, decision);
}

describe("OpenClawApp exec approval decisions", () => {
  it("dismisses stale approvals that the backend has already expired", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("unknown or expired approval id"), {
        details: { reason: "APPROVAL_NOT_FOUND" },
      });
    });
    const app: ExecApprovalApp = {
      client: { request },
      execApprovalQueue: [createApproval("approval-1")],
      execApprovalBusy: false,
      execApprovalError: null,
    };

    await runDecision(app, "deny");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "deny",
    });
    expect(app.execApprovalQueue).toEqual([]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
  });

  it("dismisses stale approvals that were resolved from another surface", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("approval already resolved"), {
        details: { reason: "APPROVAL_ALREADY_RESOLVED" },
      });
    });
    const app: ExecApprovalApp = {
      client: { request },
      execApprovalQueue: [createApproval("approval-2")],
      execApprovalBusy: false,
      execApprovalError: null,
    };

    await runDecision(app, "allow-once");

    expect(app.execApprovalQueue).toEqual([]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
  });

  it("keeps the approval visible when resolve fails for a non-terminal reason", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway not connected");
    });
    const approval = createApproval("approval-3");
    const app: ExecApprovalApp = {
      client: { request },
      execApprovalQueue: [approval],
      execApprovalBusy: false,
      execApprovalError: null,
    };

    await runDecision(app, "deny");

    expect(app.execApprovalQueue).toEqual([approval]);
    expect(app.execApprovalError).toBe("Approval failed: Error: gateway not connected");
    expect(app.execApprovalBusy).toBe(false);
  });
});
