import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedMessageAuditEvent,
  resetMessageAuditEventsForTest,
  type TrustedMessageAuditEvent,
} from "../../audit/message-audit-events.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";

describe("outbound audit projection", () => {
  beforeEach(() => resetMessageAuditEventsForTest());
  afterEach(() => resetMessageAuditEventsForTest());

  it("keeps mixed logical payloads distinct under one durable queue intent", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: {
          channel: "matrix",
          to: "!room:target",
          payloads: [{ text: "suppressed" }, { text: "sent" }],
          session: { conversationKind: "channel" },
          mirror: { sessionKey: "secret-session", agentId: "mirror-agent", isGroup: true },
        },
        terminals: () =>
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
        startedAt: Date.now(),
        queueId: "queue-1",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(2);
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

  it("preserves unknown delivery state without inventing a failure code", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent?" }] },
        terminals: uniformOutboundAuditTerminals(1, {
          outcome: "unknown",
          failureStage: "platform_send",
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("errorCode");
  });

  it("treats a missing adapter identity as unknown rather than a proven suppression", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent?" }] },
        terminals: completedOutboundAuditTerminals({
          payloadCount: 1,
          results: [],
          payloadOutcomes: [
            { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          ],
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

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

  it("counts physical sends once across receipt representations and result fallbacks", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "batch" }] },
        terminals: uniformOutboundAuditTerminals(1, {
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
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "succeeded",
      outcome: "sent",
      resultCount: 6,
    });
  });
});
