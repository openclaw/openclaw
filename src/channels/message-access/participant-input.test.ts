import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  getForegroundUserRequest,
  prepareForegroundUserRequestClaim,
} from "../../agents/foreground-request.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

it.each(["user", "source-less", "heartbeat", "system", "retired", "retired-role"] as const)(
  "admits foreground work only from current verified channel input with audit disabled: %s",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let live = true;
      const gateway = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
      const owner = { channelId: "test", isLive: () => live, resolveGatewayContext: () => gateway };
      const sessionKey = "agent:main:test:dm:foreground";
      const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
        channelId: "test",
        accountId: "local",
        identity: { authentication: "verified" },
        subject: { stableId: "sender" },
        conversation: { kind: "direct", id: "foreground" },
        contextBinding: {
          agentId: "main",
          sessionKey,
          messageId: kind === "source-less" ? undefined : "input",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
        groupPolicy: "disabled",
        allowFrom: ["*"],
        useDefaultPairingStore: false,
      });
      const context = await createHostChannelInboundEventContextBuilder(
        (params: BuildChannelInboundEventContextParams) => {
          const built = buildChannelInboundEventContext(params);
          if (kind === "heartbeat") {
            built.InternalTurnSource = "heartbeat";
          }
          if (kind === "system") {
            built.InputProvenance = { kind: "internal_system", sourceTool: "fixture" };
          }
          return built;
        },
        owner,
      )({
        channel: "test",
        accountId: "local",
        messageId: kind === "source-less" ? undefined : "input",
        from: "test:foreground",
        sender: { id: "sender" },
        conversation: { kind: "direct", id: "foreground" },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: "test:foreground" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      });
      expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
      live = !kind.startsWith("retired");
      const request = getForegroundUserRequest({ ...context });
      const admission = prepareChannelRunAdmission({
        cfg: {},
        runId: `channel-${kind}`,
        agentId: "main",
        ingressKind: "channel",
        boundary: "test",
        foregroundRequest: request,
        operatorAuthority:
          kind === "retired-role" || kind === "source-less"
            ? createAdmittedRunOperatorAuthority({
                profileId: "source",
                scopes: ["operator.write"],
                assertCurrent() {},
                rolePolicy: {
                  sessionAccessCap: "none",
                  sandboxRequired: true,
                  agents: "*",
                  execution: "foreground-only",
                },
              })
            : undefined,
      });
      try {
        if (kind === "retired-role") {
          await expect(admission.admit("embedded")).rejects.toThrow("no longer active");
        } else {
          const admitted = await admission.admit("embedded");
          const claim = prepareForegroundUserRequestClaim(request, admitted.operationalRunInstance);
          if (kind === "retired") {
            expect(expectDefined(claim, "channel input claim")).toThrow("no longer active");
          } else if (kind === "user" || kind === "source-less") {
            expect(expectDefined(claim, "channel input claim")).not.toThrow();
          } else {
            expect(claim).toBeUndefined();
          }
        }
      } finally {
        live = false;
        await admission.close();
      }
    });
  },
);

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
