import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionDecisionCursorError } from "../../audit/execution-decision-receipts.js";
import { auditHandlers } from "./audit.js";

const { inspectExecutionIdentityRun, listAuditEvents } = vi.hoisted(() => ({
  inspectExecutionIdentityRun: vi.fn(),
  listAuditEvents: vi.fn(),
}));

vi.mock("../../audit/audit-event-store.js", () => ({ listAuditEvents }));
vi.mock("../../audit/execution-identity-context.js", () => ({ inspectExecutionIdentityRun }));

const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const eventMetadata = { schemaVersion: 1, redaction: "metadata_only" };
const runEvent = {
  ...eventMetadata,
  eventId: "event-1",
  sequence: 10,
  sourceSequence: 2,
  occurredAt: 100,
  kind: "agent_run",
  action: "agent.run.finished",
  status: "succeeded",
  agentId: "main",
  runId: "run-1",
};
const messageEvent = {
  ...eventMetadata,
  eventId: "event-message-1",
  sequence: 11,
  sourceSequence: 3,
  occurredAt: 101,
  kind: "message",
  action: "message.outbound.finished",
  status: "succeeded",
  direction: "outbound",
  channel: "telegram",
  conversationKind: "direct",
  outcome: "sent",
  deliveryKind: "text",
  durationMs: 12,
  resultCount: 1,
  accountRef,
  targetRef: accountRef,
};
const unknownIdentity = {
  state: "unknown",
  reasonCode: "run_not_found",
  missingEvidence: ["run.record"],
  remediation: [],
};
const unknownCoverage = { state: "unknown", missingEvidence: ["run.record"] };

function expectInvalid(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
}

async function runAuditHandler(
  method: "audit.activity.list" | "audit.list" | "audit.run.inspect",
  params: object,
) {
  const respond = vi.fn();
  await expectDefined(auditHandlers[method], "audit handler")({ params, respond } as never);
  return respond;
}

async function expectInspection(params: object, selected: object = params) {
  await runAuditHandler("audit.run.inspect", params);
  expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith(selected);
}

describe("audit gateway methods", () => {
  beforeEach(() => {
    listAuditEvents.mockReset().mockReturnValue({
      events: [{ ...runEvent, actorType: "agent", actorId: "main" }],
      nextCursor: 10,
    });
    inspectExecutionIdentityRun.mockReset().mockReturnValue({
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        ...unknownIdentity,
        remediation: [{ code: "verify_run_id", text: "Verify the exact run id." }],
      },
      decisions: [],
      decisionDisplays: [],
      coverage: unknownCoverage,
    });
  });

  it("preserves the exact shipped audit.list request and result shape", async () => {
    const respond = await runAuditHandler("audit.list", {
      agentId: " main ",
      kind: "agent_run",
      sessionKey: " agent:main:main ",
      runId: " run-1 ",
      after: 50,
      before: 150,
      limit: 25,
      cursor: " 11 ",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 25,
      cursor: 11,
      filters: {
        agentId: "main",
        kind: "agent_run",
        sessionKey: "agent:main:main",
        runId: "run-1",
        after: 50,
        before: 150,
      },
    });
    const { schemaVersion: _schemaVersion, ...legacyEvent } = runEvent;
    expect(respond).toHaveBeenCalledWith(true, {
      events: [{ ...legacyEvent, actor: { type: "agent", id: "main" } }],
      nextCursor: "10",
    });
  });

  it("keeps message filters invalid on the shipped audit.list method", async () => {
    const respond = await runAuditHandler("audit.list", { kind: "message" });

    expectInvalid(respond);
    expect(listAuditEvents).not.toHaveBeenCalled();
  });

  it("returns versioned message activity without synthetic run provenance", async () => {
    listAuditEvents.mockReturnValue({
      events: [{ ...messageEvent, actorType: "system", actorId: "gateway" }],
    });

    const respond = await runAuditHandler("audit.activity.list", {
      kind: "message",
      direction: "outbound",
      channel: "telegram",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 100,
      filters: {
        includeMessages: true,
        kind: "message",
        direction: "outbound",
        channel: "telegram",
      },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        {
          eventType: "outbound_message",
          ...messageEvent,
          actor: { type: "system", id: "gateway" },
        },
      ],
    });
  });

  it("projects a store-validated channel-sender identity", async () => {
    listAuditEvents.mockReturnValue({
      events: [
        {
          ...eventMetadata,
          eventId: "event-message-2",
          sequence: 12,
          sourceSequence: 4,
          occurredAt: 102,
          kind: "message",
          action: "message.inbound.processed",
          status: "succeeded",
          actorType: "channel_sender",
          actorId: accountRef,
          direction: "inbound",
          channel: "telegram",
          conversationKind: "direct",
          outcome: "completed",
        },
      ],
    });

    const respond = await runAuditHandler("audit.activity.list", {
      kind: "message",
      direction: "inbound",
    });

    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        expect.objectContaining({
          eventType: "inbound_message",
          actor: { type: "channel_sender", id: accountRef },
        }),
      ],
    });
  });

  it.each([
    { kind: "agent_run", direction: "inbound" },
    { kind: "agent_run", channel: "telegram" },
    { kind: "message", sessionKey: "agent:main:main" },
    { sessionKey: "agent:main:main", direction: "inbound" },
    { sessionKey: "agent:main:main", channel: "telegram" },
  ])(
    "rejects impossible activity filters before storage: $kind $direction $channel",
    async (params) => {
      const respond = await runAuditHandler("audit.activity.list", params);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("invalid audit.activity.list filters"),
        }),
      );
      expect(listAuditEvents).not.toHaveBeenCalled();
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "rejects malformed cursors and inverted ranges for %s",
    async (method) => {
      expectInvalid(await runAuditHandler(method, { cursor: "bad" }));
      expectInvalid(await runAuditHandler(method, { after: 2, before: 1 }));
      expect(listAuditEvents).not.toHaveBeenCalled();
    },
  );

  it("projects bounded run discovery and exact execution selection", async () => {
    const page = {
      runId: "run-1",
      executionLimit: 10,
      decisionCursor: "a:2000:42",
      decisionLimit: 25,
    };
    await expectInspection({ ...page, executionCursor: " 2 " }, { ...page, executionOffset: 2 });
    await expectInspection({ executionId: "execution-1", decisionLimit: 20 });
    await expectInspection({ executionId: "execution-1", decisionCursor: "1", decisionLimit: 20 });
  });

  it("serializes only the safe decision projection", async () => {
    const secret = (field: string) => `SYNTHETIC_PRIVATE_${field}`;
    inspectExecutionIdentityRun.mockReturnValueOnce({
      schemaVersion: 1,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: unknownIdentity,
      decisions: [
        {
          schemaVersion: 1,
          receiptId: secret("receipt"),
          contextId: secret("context"),
          executionId: secret("execution"),
          runId: secret("run"),
          actionId: secret("eventId"),
          occurredAt: 1,
          action: {
            family: "tool",
            operation: "execute",
            resourceRef: secret("resource"),
            targetRef: secret("target"),
            summary: secret("generic"),
          },
          decision: { outcome: "allowed", reasonCode: secret("reason") },
          enforcement: {
            coverageState: "enforced",
            evaluatorRef: secret("evaluator"),
            policyRefs: [secret("policy")],
            grantRefs: [secret("grant")],
            contextFieldsUsed: [],
          },
          source: {
            owner: secret("owner"),
            recordRef: secret("resolutionRef"),
            decisionBoundary: secret("record"),
          },
          missingEvidence: [],
          remediation: [{ code: secret("remediationCode"), text: secret("remediationText") }],
        },
      ],
      decisionDisplays: [],
      coverage: unknownCoverage,
    });

    const respond = await runAuditHandler("audit.run.inspect", { executionId: "execution-1" });
    const result = respond.mock.calls[0]?.[1];
    const json = JSON.stringify(result);

    expect(result).not.toHaveProperty("decisions");
    expect(result).toMatchObject({ decisionDisplays: [], coverage: expect.any(Object) });
    for (const rawKey of ["receiptId", "resolutionRef", "eventId"]) {
      expect(json).not.toContain(`"${rawKey}"`);
    }
    expect(json).not.toContain("SYNTHETIC_PRIVATE_");
  });

  it.each([
    ["001", 1],
    ["a:2000:42", undefined],
  ] as const)(
    "preserves mirrored decision cursor %s without inventing an execution offset",
    async (decisionCursor, executionOffset) => {
      const request = { runId: "run-1", decisionCursor, decisionLimit: 25 };
      await expectInspection(
        { ...request, executionCursor: decisionCursor },
        {
          ...request,
          executionLimit: 50,
          ...(executionOffset === undefined ? {} : { executionOffset }),
        },
      );
    },
  );

  it("rejects malformed run inspection before storage access", async () => {
    expectInvalid(await runAuditHandler("audit.run.inspect", { runId: "", extra: true }));
    for (const decisionCursor of ["0", "-1", "1.5", "1a", "a:1:2x", "9007199254740992"]) {
      expectInvalid(await runAuditHandler("audit.run.inspect", { runId: "run-1", decisionCursor }));
    }
    expectInvalid(
      await runAuditHandler("audit.run.inspect", {
        runId: "run-1",
        executionId: "execution-1",
      }),
    );
    expect(inspectExecutionIdentityRun).not.toHaveBeenCalled();
  });

  it("tells the operator how to recover from an expired decision cursor", async () => {
    inspectExecutionIdentityRun.mockImplementationOnce(() => {
      throw new ExecutionDecisionCursorError(
        "decision cursor is no longer retained; restart inspection without --cursor",
      );
    });

    const respond = await runAuditHandler("audit.run.inspect", {
      runId: "run-1",
      decisionCursor: "a:2000:42",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "decision cursor is no longer retained; restart inspection without --cursor",
      }),
    );
  });
});
