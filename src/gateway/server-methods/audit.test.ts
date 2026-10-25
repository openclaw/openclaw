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
const eventMetadata = {
  schemaVersion: 1,
  redaction: "metadata_only",
  eventId: "event-1",
  sequence: 10,
  sourceSequence: 2,
  occurredAt: 100,
};
const runEvent = {
  ...eventMetadata,
  kind: "agent_run",
  action: "agent.run.finished",
  status: "succeeded",
  agentId: "main",
  runId: "run-1",
};
const messageMetadata = {
  ...eventMetadata,
  kind: "message",
  status: "succeeded",
  channel: "telegram",
  conversationKind: "direct",
};
const messageEvent = {
  ...messageMetadata,
  action: "message.outbound.finished",
  direction: "outbound",
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
const unknownInspection = {
  schemaVersion: 1,
  run: { runId: "run-1", status: "unknown" },
  identity: unknownIdentity,
  decisions: [],
  decisionDisplays: [],
  coverage: { state: "unknown", missingEvidence: ["run.record"] },
};

function expectInvalid(respond: ReturnType<typeof vi.fn>, message?: unknown) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    message === undefined ? expect.any(Object) : expect.objectContaining({ message }),
  );
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
    inspectExecutionIdentityRun.mockReset().mockReturnValue(unknownInspection);
  });

  it("preserves legacy event projection and range filters", async () => {
    const respond = await runAuditHandler("audit.list", {
      kind: "agent_run",
      after: 50,
      before: 150,
    });

    // Real-store pagination and padded filters are covered in audit.trim.store.test.ts.
    expect(listAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ kind: "agent_run", after: 50, before: 150 }),
      }),
    );
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

  it.each([
    { event: messageEvent, actor: { type: "system", id: "gateway" }, channel: "telegram" },
    {
      event: {
        ...messageMetadata,
        action: "message.inbound.processed",
        direction: "inbound",
        outcome: "completed",
      },
      actor: { type: "channel_sender", id: accountRef },
    },
  ])(
    "projects versioned $event.direction activity with its validated actor",
    async ({ event, actor, channel }) => {
      listAuditEvents.mockReturnValue({
        events: [{ ...event, actorType: actor.type, actorId: actor.id }],
      });
      const filters = {
        kind: "message",
        direction: event.direction,
        ...(channel ? { channel } : {}),
      };
      const respond = await runAuditHandler("audit.activity.list", filters);
      expect(listAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: { includeMessages: true, ...filters },
        }),
      );
      const projected = { eventType: `${event.direction}_message`, actor };
      expect(respond).toHaveBeenCalledWith(true, {
        events: [channel ? { ...event, ...projected } : expect.objectContaining(projected)],
      });
    },
  );

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

      expectInvalid(respond, expect.stringContaining("invalid audit.activity.list filters"));
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
    inspectExecutionIdentityRun.mockReturnValueOnce({
      ...unknownInspection,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: unknownIdentity,
      // The Gateway must omit this opaque collection, irrespective of its private fields.
      decisions: [{ receiptId: "SYNTHETIC_PRIVATE_receiptId" }],
    });

    const respond = await runAuditHandler("audit.run.inspect", { executionId: "execution-1" });
    const result = respond.mock.calls[0]?.[1];
    const json = JSON.stringify(result);

    expect(result).not.toHaveProperty("decisions");
    expect(result).toMatchObject({ decisionDisplays: [], coverage: expect.any(Object) });
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
    const message = "decision cursor is no longer retained; restart inspection without --cursor";
    inspectExecutionIdentityRun.mockImplementationOnce(() => {
      throw new ExecutionDecisionCursorError(message);
    });

    const respond = await runAuditHandler("audit.run.inspect", {
      runId: "run-1",
      decisionCursor: "a:2000:42",
    });
    expectInvalid(respond, message);
  });
});
