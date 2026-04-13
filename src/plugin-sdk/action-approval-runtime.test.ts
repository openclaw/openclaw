import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeTaskFlow } from "../../test/helpers/plugins/runtime-taskflow.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-flow-registry.js";
import {
  ACTION_APPROVAL_INTERACTIVE_DATA_KEY,
  ACTION_APPROVAL_SCHEMA_VERSION,
  buildActionApprovalInteractiveData,
  buildTeamsActionApprovalCard,
  claimActionApprovalFlow,
  createWaitingActionApprovalFlow,
  decodeActionApprovalInteractivePayload,
  finishClaimedActionApprovalFlow,
  hashActionApprovalSnapshot,
  loadActionApprovalFlow,
  resolveActionApprovalDecision,
} from "./action-approval-runtime.js";

afterEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("action approval runtime", () => {
  it("creates and loads a waiting approval flow with a stable snapshot hash", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const snapshot = {
      identityId: "user-1",
      messageId: "mid-1",
      recipients: ["a@example.com"],
    };

    const created = createWaitingActionApprovalFlow({
      taskFlow,
      controllerId: "tests/action-approval",
      goal: "Queue reply approval",
      action: {
        kind: "mail.reply",
        title: "Reply to customer",
      },
      snapshot,
    });

    expect(created.snapshotHash).toBe(hashActionApprovalSnapshot(snapshot));
    expect(created.flow.status).toBe("waiting");

    const loaded = loadActionApprovalFlow<typeof snapshot>({
      taskFlow,
      flowId: created.flow.flowId,
      expectedRevision: created.expectedRevision,
      snapshotHash: created.snapshotHash,
    });

    expect(loaded).toMatchObject({
      ok: true,
      flow: expect.objectContaining({
        flowId: created.flow.flowId,
        status: "waiting",
      }),
      state: expect.objectContaining({
        status: "pending",
        snapshot,
      }),
    });
  });

  it("claims approvals exactly once and finishes the claimed flow", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const created = createWaitingActionApprovalFlow({
      taskFlow,
      controllerId: "tests/action-approval",
      goal: "Queue calendar approval",
      action: {
        kind: "calendar.update",
        title: "Move customer sync",
      },
      snapshot: {
        eventId: "evt-1",
        planHash: "plan-1",
      },
    });

    const claimed = claimActionApprovalFlow({
      taskFlow,
      flowId: created.flow.flowId,
      expectedRevision: created.expectedRevision,
      snapshotHash: created.snapshotHash,
      actorId: "approver-1",
    });

    expect(claimed).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "running",
      }),
      state: expect.objectContaining({
        status: "claimed",
        decision: "approve",
        actorId: "approver-1",
      }),
    });
    if (!claimed.applied) {
      throw new Error("expected claim to succeed");
    }

    const duplicate = claimActionApprovalFlow({
      taskFlow,
      flowId: created.flow.flowId,
      expectedRevision: created.expectedRevision,
      snapshotHash: created.snapshotHash,
      actorId: "approver-2",
    });

    expect(duplicate).toMatchObject({
      applied: false,
      code: "revision_conflict",
    });

    const finished = finishClaimedActionApprovalFlow({
      taskFlow,
      flowId: claimed.flow.flowId,
      expectedRevision: claimed.flow.revision,
      snapshotHash: claimed.snapshotHash,
      result: {
        graphRequestId: "req-1",
      },
    });

    expect(finished).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "succeeded",
      }),
      state: expect.objectContaining({
        status: "succeeded",
        decision: "approve",
      }),
    });
  });

  it("resolves deny and revise as terminal failures without sending", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const created = createWaitingActionApprovalFlow({
      taskFlow,
      controllerId: "tests/action-approval",
      goal: "Queue thread side effect",
      action: {
        kind: "msteams.post_summary",
        title: "Post summary",
      },
      snapshot: {
        teamId: "team-1",
        rootMessageId: "root-1",
      },
    });

    const denied = resolveActionApprovalDecision({
      taskFlow,
      flowId: created.flow.flowId,
      expectedRevision: created.expectedRevision,
      snapshotHash: created.snapshotHash,
      decision: "deny",
      actorId: "approver-1",
    });

    expect(denied).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "failed",
      }),
      state: expect.objectContaining({
        status: "denied",
        decision: "deny",
        actorId: "approver-1",
      }),
    });
  });

  it("builds Teams approval cards with namespace payloads that round-trip", () => {
    const interactiveData = buildActionApprovalInteractiveData({
      namespace: "m365.approval",
      payload: {
        version: ACTION_APPROVAL_SCHEMA_VERSION,
        ownerSessionKey: "agent:main:main",
        flowId: "flow-1",
        expectedRevision: 3,
        snapshotHash: "hash-1",
        decision: "approve",
        action: {
          kind: "mail.reply",
          title: "Reply to thread",
          highRisk: true,
        },
      },
    });
    const card = buildTeamsActionApprovalCard({
      namespace: "m365.approval",
      ownerSessionKey: "agent:main:main",
      flowId: "flow-1",
      expectedRevision: 3,
      snapshotHash: "hash-1",
      action: {
        kind: "mail.reply",
        title: "Reply to thread",
        summary: "High-risk because this is reply-all.",
        highRisk: true,
      },
    });
    const actionData = (card.actions as Array<{ data?: Record<string, unknown> }>)[0]?.data;
    const encoded =
      typeof actionData?.[ACTION_APPROVAL_INTERACTIVE_DATA_KEY] === "string"
        ? actionData[ACTION_APPROVAL_INTERACTIVE_DATA_KEY]
        : null;

    expect(encoded).toBe(interactiveData);
    expect(encoded?.startsWith("m365.approval:")).toBe(true);
    const payload = decodeActionApprovalInteractivePayload(encoded!.split(":").slice(1).join(":"));
    expect(payload).toMatchObject({
      ownerSessionKey: "agent:main:main",
      flowId: "flow-1",
      expectedRevision: 3,
      snapshotHash: "hash-1",
      decision: "approve",
      action: {
        kind: "mail.reply",
        title: "Reply to thread",
        highRisk: true,
      },
    });
  });
});
