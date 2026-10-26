import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
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

function expectIsolated(run: () => void) {
  expect(() => captureEvents(run)).not.toThrow();
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
        session: { conversationKind: "channel" },
        mirror: { sessionKey: "secret-session", agentId: "mirror-agent", isGroup: true },
      },
      "queue-1",
    );

    expect(events).toMatchObject([
      {
        sourceId: "message:outbound:queue:queue-1:payload:0",
        outcome: "suppressed",
        status: "blocked",
        actorType: "agent",
        actorId: "mirror-agent",
        agentId: "mirror-agent",
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

  it("keeps an unidentified attempt unknown even after a later successful send", () => {
    const events = captureTerminals(
      failedOutboundAuditTerminals({
        payloadCount: 1,
        results: [],
        failureStage: "platform_send",
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          { index: 0, status: "sent", results: [result] },
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

  it("counts platform IDs when a receipt has no physical parts", () => {
    const events = captureTerminals(
      uniformOutboundAuditTerminals(1, {
        outcome: "sent",
        results: [
          {
            ...result,
            receipt: { platformMessageIds: ["id-1", "id-2", "id-3"], parts: [], sentAt: 1 },
          },
        ],
      }),
    );
    expect(events).toMatchObject([{ status: "succeeded", outcome: "sent", resultCount: 3 }]);
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
    originGroup?: boolean,
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
    ["matrix", "!room:server", undefined, "group", undefined, true],
    ["matrix", "!room:server", undefined, "unknown", undefined, false],
  ])(
    "classifies only destination-proven routes: %s %s",
    (channel, to, key, expected, session, originGroup) => {
      const mirror =
        originGroup === undefined
          ? undefined
          : {
              sessionKey: "control-session",
              agentId: "a",
              isGroup: originGroup,
            };
      const ctx = { channel, to, session: key ? { key, ...session } : session, mirror };
      expect(conversationKindFor(ctx)).toBe(expected);
    },
  );
});
