import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditLifecycle,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";

function captureEvents(run: () => void): TrustedMessageAuditEvent[] {
  const events: TrustedMessageAuditEvent[] = [];
  const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return events;
}

function captureTerminals(
  terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
  context: Parameters<typeof emitOutboundAuditTerminals>[0]["context"] = {
    channel: "matrix",
    to: "!room:target",
    payloads: [{ text: "sent?" }],
  },
  queueId?: string,
) {
  return captureEvents(() =>
    emitOutboundAuditTerminals({ context, terminals, queueId, startedAt: Date.now() }),
  );
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
      emitOutboundAuditLifecycle({
        context,
        outcome: "queued",
        queueId: "queue-1",
        startedAt: Date.now(),
      });
      emitOutboundAuditLifecycle({
        context,
        outcome: "platform_started",
        queueId: "queue-1",
        startedAt: Date.now(),
      });
    });

    expect(events).toEqual([
      expect.objectContaining({
        sourceId: "message:outbound:queue:queue-1:payload:0:queued",
        action: "message.outbound.queued",
        status: "started",
        outcome: "queued",
        runId: "run-1",
        executionIdentityToken,
      }),
      expect.objectContaining({
        sourceId: "message:outbound:queue:queue-1:payload:0:platform_started",
        action: "message.outbound.platform-started",
        status: "started",
        outcome: "platform_started",
        runId: "run-1",
        executionIdentityToken,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("secret message");
  });

  it("keeps lifecycle observers outside delivery semantics", () => {
    const unsubscribe = onTrustedMessageAuditEvent(() => {
      throw new Error("observer failed");
    });
    try {
      expect(() =>
        emitOutboundAuditLifecycle({
          context: { channel: "qa-channel", to: "target" },
          outcome: "queued",
          queueId: "queue-1",
          startedAt: Date.now(),
        }),
      ).not.toThrow();
    } finally {
      unsubscribe();
    }
  });

  it("keeps mixed logical payloads distinct under one durable queue intent", () => {
    const events = captureTerminals(
      () =>
        completedOutboundAuditTerminals({
          payloadCount: 2,
          results: [{ channel: "matrix", messageId: "platform-1" }],
          payloadOutcomes: [
            { index: 0, status: "suppressed", reason: "no_visible_payload" },
            {
              index: 1,
              status: "sent",
              deliveryKind: "media",
              results: [{ channel: "matrix", messageId: "platform-1" }],
            },
          ],
        }),
      {
        channel: "matrix",
        to: "!room:target",
        payloads: [{ text: "suppressed" }, { text: "sent" }],
        session: { conversationKind: "channel" },
        mirror: { sessionKey: "secret-session", agentId: "mirror-agent", isGroup: true },
      },
      "queue-1",
    );

    expect(events.map((event) => event.sourceId)).toEqual([
      "message:outbound:queue:queue-1:payload:0",
      "message:outbound:queue:queue-1:payload:1",
    ]);
    expect(events.map((event) => event.outcome)).toEqual(["suppressed", "sent"]);
    expect(events[0]).toMatchObject({
      status: "blocked",
      actorType: "agent",
      actorId: "mirror-agent",
      agentId: "mirror-agent",
      conversationKind: "channel",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("deliveryKind");
    expect(events[1]).toMatchObject({
      status: "succeeded",
      deliveryKind: "media",
      messageId: "platform-1",
      resultCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain("secret-session");
  });

  it("does not resolve terminal metadata without an active listener", () => {
    const resolveTerminals = vi.fn(() => []);
    emitOutboundAuditTerminals({
      context: { channel: "matrix", to: "!room:target", payloads: [{ text: "secret" }] },
      terminals: resolveTerminals,
      startedAt: Date.now(),
    });
    expect(resolveTerminals).not.toHaveBeenCalled();
  });

  it("isolates terminal projection failures from delivery", () => {
    const unsubscribe = onTrustedMessageAuditEvent(() => {});
    try {
      expect(() =>
        emitOutboundAuditTerminals({
          context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent" }] },
          terminals: () => {
            throw new Error("bad terminal projection");
          },
          startedAt: Date.now(),
        }),
      ).not.toThrow();

      expect(() =>
        emitOutboundAuditTerminals({
          context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent" }] },
          terminals: uniformOutboundAuditTerminals(1, {
            outcome: "sent",
            results: [
              {
                channel: "matrix",
                messageId: "platform-1",
                receipt: {} as never,
              },
            ],
          }),
          startedAt: Date.now(),
        }),
      ).not.toThrow();
    } finally {
      unsubscribe();
    }
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("reasonCode");
    expect(events[0]).not.toHaveProperty("deliveryKind");
  });

  it("projects recorded history consistently for failed runs", () => {
    const project = (payloadOutcomes: OutboundPayloadDeliveryOutcome[]) =>
      failedOutboundAuditTerminals({
        payloadCount: 1,
        results: [],
        payloadOutcomes,
        failureStage: "platform_send",
      });
    const result = { channel: "matrix" as const, messageId: "platform-1" };

    expect(
      project([
        { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
        { index: 0, status: "sent", results: [result] },
      ]),
    ).toEqual([
      {
        payloadIndex: 0,
        terminal: { outcome: "unknown", failureStage: "platform_send" },
      },
    ]);
    expect(
      project([{ index: 0, status: "sent", results: [result], deliveryKind: "media" }]),
    ).toEqual([
      {
        payloadIndex: 0,
        terminal: { outcome: "sent", results: [result], deliveryKind: "media" },
      },
    ]);
    expect(project([{ index: 0, status: "suppressed", reason: "no_visible_payload" }])).toEqual([
      {
        payloadIndex: 0,
        terminal: { outcome: "suppressed", reasonCode: "no_visible_payload" },
      },
    ]);
  });

  it("counts physical sends once across receipt representations and result fallbacks", () => {
    const events = captureTerminals(
      uniformOutboundAuditTerminals(1, {
        outcome: "sent",
        results: [
          {
            channel: "matrix",
            messageId: "aggregate-with-parts",
            receipt: {
              primaryPlatformMessageId: "part-1",
              platformMessageIds: ["part-1", "part-2"],
              parts: [
                { platformMessageId: "part-1", kind: "text", index: 0 },
                { platformMessageId: "part-2", kind: "text", index: 1 },
              ],
              sentAt: Date.now(),
            },
          },
          {
            channel: "matrix",
            messageId: "aggregate-with-ids",
            receipt: {
              platformMessageIds: ["id-1", "id-2", "id-3"],
              parts: [],
              sentAt: Date.now(),
            },
          },
          { channel: "matrix", messageId: "single-result" },
        ],
      }),
      { channel: "matrix", to: "!room:target", payloads: [{ text: "batch" }] },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "succeeded",
      outcome: "sent",
      resultCount: 6,
    });
  });

  function conversationKindFor(
    context: Omit<Parameters<typeof emitOutboundAuditTerminals>[0]["context"], "payloads">,
  ): string | undefined {
    const events = captureTerminals(
      uniformOutboundAuditTerminals(1, {
        outcome: "sent",
        results: [{ channel: context.channel, messageId: "m-1" }],
      }),
      { ...context, payloads: [{ text: "x" }] },
    );
    return events[0]?.conversationKind;
  }

  it("classifies direct only from a session route naming this exact destination", () => {
    const cases = [
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
    ] as const;
    for (const [channel, to, key, expected] of cases) {
      expect(conversationKindFor({ channel, to, session: { key } }), to).toBe(expected);
    }
  });

  it("does not treat Object.prototype keys as target-kind prefixes", () => {
    // constructor: is a legal destination prefix, not an own key of the kind map.
    // Looking it up on the object literal used to yield Function.prototype, and
    // allowedRouteKinds.includes then threw on the audit path.
    expect(
      conversationKindFor({
        channel: "slack",
        to: "constructor:123",
        session: { key: "agent:main:slack:default:direct:constructor:123" },
      }),
    ).toBe("direct");
  });

  it("does not classify by a policy session that names another conversation", () => {
    // Native command acting on a WhatsApp DM session, response delivered to a
    // Matrix room: the acted-on session must not stamp the destination "direct".
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        session: {
          key: "agent:main:matrix:default:direct:@user:server",
          policyKey: "agent:main:whatsapp:default:direct:+15551234567",
          conversationType: "direct",
        },
      }),
    ).toBe("unknown");
  });

  it("lets weak origin facts escalate to group but never to direct", () => {
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        mirror: { sessionKey: "control-session", agentId: "a", isGroup: true },
      }),
    ).toBe("group");
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        mirror: { sessionKey: "control-session", agentId: "a", isGroup: false },
      }),
    ).toBe("unknown");
  });
});
