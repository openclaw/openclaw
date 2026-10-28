import { expect, it, vi } from "vitest";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  readChannelContextAdmissionEvidence as readEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";

const recordParticipant = vi.hoisted(() => vi.fn());
const remote = { domain: "workspace-one", idKind: "user-id", id: "profile-collision" };
const identities: SessionParticipantIdentity[] = [
  { type: "remote", pluginId: "test", ...remote },
  {
    type: "observation",
    pluginId: "test",
    accountId: "local",
    senderKind: "unknown",
    id: "unknown",
  },
];
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
] as const)("binds accepted input to its current host: %s", async (scenario) => {
  recordParticipant.mockClear();
  const auditEnabled = scenario.includes("during");
  const audit = createChannelAdmissionAudit({ enabled: auditEnabled });
  const host = createHostIngressFixture("test", {}, { channelAdmissionAudit: audit });
  const key = "agent:main:test:dm:conversation";
  const resolveParticipant = vi.fn((subject: { stableId?: string | number | null }) =>
    subject.stableId === "unknown" ? undefined : { ...remote, id: String(subject.stableId) },
  );
  try {
    const sources = scenario === "mixed" ? [remote.id, "unknown"] : [remote.id];
    const ingress = [];
    const startedAt = Date.now();
    const messageFor = (id: string) => ingressMessage("test", key, id, { accountId: "local" });
    for (const sender of sources) {
      ingress.push(
        await host.ingress.resolveStable(
          ingressInput(messageFor(sender), {
            identity: { resolveParticipant },
            dmPolicy: scenario === "gateway-replaced-during-ingress" ? "pairing" : "open",
            allowFrom: scenario === "denied" ? [] : ["*"],
            readStoreAllowFrom: async () => {
              await Promise.resolve();
              if (scenario === "gateway-replaced-during-ingress") {
                host.replaceGatewayContext();
              }
              return [];
            },
          }),
        ),
      );
    }
    expect(resolveParticipant).toHaveBeenCalledTimes(sources.length);
    expect(ingress[0]?.ingress.admission).toBe(scenario === "denied" ? "drop" : "dispatch");
    if (scenario === "stale") {
      host.retire();
    }
    const context = await createHostChannelInboundEventContextBuilder(
      async (params: ReturnType<typeof ingressMessage>) => {
        await Promise.resolve();
        if (scenario === "gateway-replaced-during-context") {
          host.replaceGatewayContext();
        }
        if (scenario === "retired-during-context") {
          host.retire();
        }
        return buildChannelInboundEventContext(params);
      },
      host.owner,
    )({
      ...messageFor(sources.at(-1)!),
      route: {
        agentId: "main",
        routeSessionKey: scenario === "retargeted" ? "agent:main:other" : key,
      },
      channelIngress: ingress,
    });
    const target = { agentId: "main", sessionKey: key, storePath: "/unused" };
    void recordAcceptedSessionParticipantInput({ ...context }, target);
    void recordAcceptedSessionParticipantInput(context, target);
    if (scenario === "qualified" || scenario === "mixed") {
      expect(recordParticipant.mock.calls).toEqual(
        identities
          .slice(0, sources.length)
          .map((identity) => [{ ...target, identity, promptedAt: expect.any(Number) }]),
      );
      expect(recordParticipant.mock.calls[0]?.[0].promptedAt).toBeGreaterThanOrEqual(startedAt);
    } else {
      expect(recordParticipant).not.toHaveBeenCalled();
    }
    if (auditEnabled) {
      expect(consumeChannelAdmissionEvidence(readEvidence(context))).toMatchObject({
        ingressState: "unknown",
      });
      expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
    } else {
      expect(readEvidence(context)).toBeUndefined();
    }
    expect(ingress[0]).not.toHaveProperty("participant");
  } finally {
    host.retire();
    audit.close();
  }
});
