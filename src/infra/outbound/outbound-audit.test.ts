import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { OutboundAuditTerminal, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditLifecycle,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";

const baseContext = { channel: "matrix", to: "!room:target", payloads: [{ text: "secret" }] };
const result = { channel: "matrix" as const, messageId: "platform-1" };
type AuditContext = Parameters<typeof emitOutboundAuditTerminals>[0]["context"];

function captureEvents(run: () => void, onEvent?: () => void): TrustedMessageAuditEvent[] {
  const events: TrustedMessageAuditEvent[] = [];
  const unsubscribe = onTrustedMessageAuditEvent(onEvent ?? ((event) => events.push(event)));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return events;
}

function emitTerminals(
  terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
  ctx: AuditContext = baseContext,
  queueId?: string,
) {
  emitOutboundAuditTerminals({ context: ctx, terminals, queueId, startedAt: Date.now() });
}

function captureTerminals(...args: Parameters<typeof emitTerminals>) {
  return captureEvents(() => emitTerminals(...args));
}

function expectIsolated(run: () => void, onEvent?: () => void) {
  expect(() => captureEvents(run, onEvent)).not.toThrow();
}

describe("outbound audit projection", () => {
  it("projects replay-safe queued and platform-started lifecycle records", () => {
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-1");
    const events = captureEvents(() => {
      const context = {
        channel: "qa-channel",
        to: "raw-target",
        payloads: [{ text: "secret message" }],
        preparedBatch: { runId: "run-1", executionIdentityToken, sourcePayloadCount: 1 },
      };
      for (const outcome of ["queued", "platform_started"] as const) {
        emitOutboundAuditLifecycle({ context, outcome, queueId: "queue-1", startedAt: Date.now() });
      }
    });

    expect(events).toEqual(
      [
        ["queued", "message.outbound.queued"],
        ["platform_started", "message.outbound.platform-started"],
      ].map(([outcome, action]) =>
        expect.objectContaining({
          sourceId: `message:outbound:queue:queue-1:payload:0:${outcome}`,
          action,
          status: "started",
          outcome,
          runId: "run-1",
          executionIdentityToken,
        }),
      ),
    );
    expect(JSON.stringify(events)).not.toContain("secret message");
  });

  it("keeps lifecycle observers outside delivery semantics", () => {
    expectIsolated(
      () =>
        emitOutboundAuditLifecycle({
          context: { channel: "qa-channel", to: "target" },
          outcome: "queued",
          queueId: "queue-1",
          startedAt: Date.now(),
        }),
      () => {
        throw new Error("observer failed");
      },
    );
  });

  it("keeps mixed logical payloads distinct under one durable queue intent", () => {
    const events = captureTerminals(
      () =>
        completedOutboundAuditTerminals({
          payloadCount: 2,
          results: [result],
          payloadOutcomes: [
            { index: 0, status: "suppressed", reason: "no_visible_payload" },
            {
              index: 1,
              status: "sent",
              deliveryKind: "media",
              results: [result],
            },
          ],
        }),
      {
        ...baseContext,
        session: { conversationKind: "channel", key: "secret-session", agentId: "audit-agent" },
      },
      "queue-1",
    );

    expect(events).toMatchObject([
      {
        sourceId: "message:outbound:queue:queue-1:payload:0",
        outcome: "suppressed",
        status: "blocked",
        actorType: "agent",
        actorId: "audit-agent",
        agentId: "audit-agent",
        conversationKind: "channel",
        resultCount: 0,
      },
      {
        sourceId: "message:outbound:queue:queue-1:payload:1",
        outcome: "sent",
        status: "succeeded",
        deliveryKind: "media",
        messageId: "platform-1",
        resultCount: 1,
      },
    ]);
    expect(events[0]).not.toHaveProperty("deliveryKind");
    expect(JSON.stringify(events)).not.toContain("secret-session");
  });

  it("does not resolve terminal metadata without an active listener", () => {
    const resolveTerminals = vi.fn(() => []);
    emitTerminals(resolveTerminals);
    expect(resolveTerminals).not.toHaveBeenCalled();
  });

  it("isolates terminal projection failures from delivery", () => {
    expectIsolated(() =>
      emitTerminals(() => {
        throw new Error("bad terminal projection");
      }),
    );
    expectIsolated(() =>
      emitTerminals(
        uniformOutboundAuditTerminals(1, {
          outcome: "sent",
          results: [{ ...result, receipt: {} as never }],
        }),
      ),
    );
  });

  it("treats a missing adapter identity as unknown rather than a proven suppression", () => {
    const events = captureTerminals(
      completedOutboundAuditTerminals({
        payloadCount: 1,
        results: [],
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
        ],
      }),
    );

    expect(events).toMatchObject([
      {
        status: "unknown",
        outcome: "unknown",
        failureStage: "platform_send",
        resultCount: 0,
      },
    ]);
    expect(events[0]).not.toHaveProperty("reasonCode");
    expect(events[0]).not.toHaveProperty("deliveryKind");
  });

  it("projects recorded history consistently for failed runs", () => {
    const expectHistory = (
      payloadOutcomes: OutboundPayloadDeliveryOutcome[],
      terminal: OutboundAuditTerminal,
    ) =>
      expect(
        failedOutboundAuditTerminals({
          payloadCount: 1,
          results: [],
          payloadOutcomes,
          failureStage: "platform_send",
        }),
      ).toEqual([{ payloadIndex: 0, terminal }]);
    expectHistory(
      [
        { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
        { index: 0, status: "sent", results: [result] },
      ],
      { outcome: "unknown", failureStage: "platform_send" },
    );
    expectHistory([{ index: 0, status: "sent", results: [result], deliveryKind: "media" }], {
      outcome: "sent",
      results: [result],
      deliveryKind: "media",
    });
    expectHistory([{ index: 0, status: "suppressed", reason: "no_visible_payload" }], {
      outcome: "suppressed",
      reasonCode: "no_visible_payload",
    });
  });

  it("counts physical sends once across receipt representations and result fallbacks", () => {
    const received = (messageId: string, ids: string[], withParts: boolean) => ({
      ...result,
      messageId,
      receipt: {
        platformMessageIds: ids,
        parts: withParts
          ? ids.map((platformMessageId, index) => ({
              platformMessageId,
              index,
              kind: "text" as const,
            }))
          : [],
        sentAt: Date.now(),
      },
    });
    const events = captureTerminals(
      uniformOutboundAuditTerminals(1, {
        outcome: "sent",
        results: [
          received("aggregate-with-parts", ["part-1", "part-2"], true),
          received("aggregate-with-ids", ["id-1", "id-2", "id-3"], false),
          { channel: "matrix", messageId: "single-result" },
        ],
      }),
    );

    expect(
      events.map(({ status, outcome, resultCount }) => [status, outcome, resultCount]),
    ).toEqual([["succeeded", "sent", 6]]);
  });

  function conversationKindFor(context: AuditContext) {
    const terminals = uniformOutboundAuditTerminals(1, {
      outcome: "sent",
      results: [{ channel: context.channel, messageId: "m-1" }],
    });
    return captureTerminals(terminals, context)[0]?.conversationKind;
  }

  type ConversationCase = [
    channel: string,
    to: string,
    key: string | undefined,
    expected: string,
    session?: Parameters<typeof conversationKindFor>[0]["session"],
  ];
  it.each<ConversationCase>([
    ["matrix", "@user:server", "agent:main:matrix:default:direct:@user:server", "direct"],
    ["slack", "channel:C0AGENT", "agent:main:slack:channel:c0agent", "channel"],
    ["telegram", "telegram:999", "agent:main:telegram:default:direct:999", "direct"],
    ["slack", "group:123", "agent:main:slack:default:direct:123", "unknown"],
    ["matrix", "room:123", "agent:main:matrix:default:direct:room:123", "unknown"],
    ["discord", "discord:dm:123", "agent:main:discord:dm:123", "direct"],
    [
      "whatsapp",
      "direct:+15551234567",
      "agent:main:whatsapp:default:direct:+15551234567",
      "direct",
    ],
    // Inherited object keys must not be interpreted as target-kind rules.
    ["slack", "constructor:123", "agent:main:slack:default:direct:constructor:123", "direct"],
    [
      "matrix",
      "!room:server",
      "agent:main:matrix:default:direct:@user:server",
      "unknown",
      {
        policyKey: "agent:main:whatsapp:default:direct:+15551234567",
        conversationType: "direct",
      },
    ],
    ["matrix", "!room:server", undefined, "group", { conversationType: "group" }],
    ["matrix", "!room:server", undefined, "unknown", { conversationType: "direct" }],
  ])("classifies only destination-proven routes: %s %s", (channel, to, key, expected, session) => {
    const ctx = { channel, to, session: key ? { key, ...session } : session };
    expect(conversationKindFor(ctx)).toBe(expected);
  });
});
