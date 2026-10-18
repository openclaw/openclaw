import { expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

it.each([
  "qualified",
  "mixed",
  "stale",
  "retargeted",
  "denied",
  "gateway-replaced-during-ingress",
  "gateway-replaced-during-context",
  "retired-during-context",
] as const)(
  "preserves accepted product identity and exact host ownership: %s",
  async (scenario) => {
    recordParticipant.mockClear();
    let live = true;
    const auditEnabled = scenario.includes("during");
    const audit = createChannelAdmissionAudit({ enabled: auditEnabled });
    let gateway = {
      getRuntimeConfig: () => ({}),
      channelAdmissionAudit: audit,
    } as GatewayRequestContext;
    const owner = {
      channelId: "test",
      isLive: () => live,
      resolveGatewayContext: () => gateway,
    };
    const resolveIngress = createHostChannelIngressRuntime(owner).resolveStable;
    const key = "agent:main:test:dm:conversation";
    const resolveParticipant = vi.fn((subject: { stableId?: string | number | null }) =>
      subject.stableId === "unknown"
        ? undefined
        : {
            domain: "workspace-one",
            idKind: "user-id",
            id: String(subject.stableId),
          },
    );
    try {
      const sources =
        scenario === "mixed" ? ["profile-collision", "unknown"] : ["profile-collision"];
      const ingress = [];
      const startedAt = Date.now();
      for (const sender of sources) {
        ingress.push(
          await resolveIngress({
            channelId: "test",
            accountId: "local",
            identity: { resolveParticipant },
            subject: { stableId: sender },
            conversation: { kind: "direct", id: "conversation" },
            contextBinding: {
              agentId: "main",
              sessionKey: key,
              messageId: sender,
              inboundEventKind: "user_request",
            },
            dmPolicy: scenario === "gateway-replaced-during-ingress" ? "pairing" : "open",
            groupPolicy: "disabled",
            allowFrom: scenario === "denied" ? [] : ["*"],
            useDefaultPairingStore: false,
            readStoreAllowFrom: async () => {
              await Promise.resolve();
              if (scenario === "gateway-replaced-during-ingress") {
                gateway = Object.assign({}, gateway);
              }
              return [];
            },
          }),
        );
      }
      expect(resolveParticipant).toHaveBeenCalledTimes(sources.length);
      expect(ingress[0]?.ingress.admission).toBe(scenario === "denied" ? "drop" : "dispatch");
      live = scenario !== "stale";
      const context = await createHostChannelInboundEventContextBuilder(
        async (params: BuildChannelInboundEventContextParams) => {
          await Promise.resolve();
          if (scenario === "gateway-replaced-during-context") {
            gateway = Object.assign({}, gateway);
          }
          if (scenario === "retired-during-context") {
            live = false;
          }
          return buildChannelInboundEventContext(params);
        },
        owner,
      )({
        channel: "test",
        accountId: "local",
        messageId: sources.at(-1),
        from: "test:conversation",
        sender: { id: sources.at(-1) },
        conversation: { kind: "direct", id: "conversation" },
        route: {
          agentId: "main",
          routeSessionKey: scenario === "retargeted" ? "agent:main:other" : key,
        },
        reply: { to: "test:conversation" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      });
      const target = { agentId: "main", sessionKey: key, storePath: "/unused" };
      recordAcceptedSessionParticipantInput({ ...context }, target);
      recordAcceptedSessionParticipantInput(context, target);
      if (scenario === "qualified" || scenario === "mixed") {
        expect(recordParticipant).toHaveBeenCalledTimes(sources.length);
        expect(recordParticipant).toHaveBeenNthCalledWith(1, {
          ...target,
          identity: {
            type: "remote",
            pluginId: "test",
            domain: "workspace-one",
            idKind: "user-id",
            id: "profile-collision",
          },
          promptedAt: expect.any(Number),
        });
        expect(recordParticipant.mock.calls[0]?.[0].promptedAt).toBeGreaterThanOrEqual(startedAt);
        if (scenario === "mixed") {
          expect(recordParticipant).toHaveBeenNthCalledWith(2, {
            ...target,
            identity: {
              type: "observation",
              pluginId: "test",
              accountId: "local",
              senderKind: "unknown",
              id: "unknown",
            },
            promptedAt: expect.any(Number),
          });
        }
      } else {
        expect(recordParticipant).not.toHaveBeenCalled();
      }
      if (auditEnabled) {
        expect(
          consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
        ).toMatchObject({ ingressState: "unknown" });
        expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
      } else {
        expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
      }
      expect(ingress[0]).not.toHaveProperty("participant");
    } finally {
      live = false;
      audit.close();
    }
  },
);
