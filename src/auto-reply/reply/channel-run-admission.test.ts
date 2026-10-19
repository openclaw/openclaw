import { describe, expect, it, onTestFinished } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import {
  combineChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import { prepareGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";

const identityConfig = { logging: { audit: { executionIdentity: true } } } as const;

function captureAdmission() {
  const identityWork: ExecutionIdentityAdmissionWork[] = [];
  const decisions: unknown[] = [];
  const audit = createChannelAdmissionAudit({
    enabled: true,
    decisionSink: (receipt) => {
      decisions.push(receipt);
      return true;
    },
  });
  const clearIdentitySink = configureExecutionIdentityAdmissionSink((work) => {
    identityWork.push(work);
    return true;
  });
  onTestFinished(() => {
    clearIdentitySink();
    audit.close();
  });
  const evidence = () =>
    createChannelParticipantAdmissionEvidence({
      audit,
      channelId: "test",
      participantId: "person-1",
    });
  const prepare = (params: Partial<Parameters<typeof prepareChannelRunAdmission>[0]> = {}) =>
    prepareChannelRunAdmission({
      cfg: identityConfig,
      runId: "run-1",
      agentId: "main",
      ingressKind: "channel",
      boundary: "test.channel",
      ...params,
    });
  return { identityWork, decisions, audit, evidence, prepare };
}

describe("channel run admission", () => {
  it.each(["unresolved", "forged"] as const)(
    "records only owner-prepared Gateway facts for a %s carrier",
    async (kind) => {
      const { identityWork, prepare } = captureAdmission();
      const ingress = prepareGatewayLocalUserIngress({
        authMethod: "token",
        authenticatedUserExpected: true,
        isLocalClient: false,
      });
      const gatewayLocalUserIngress =
        kind === "forged"
          ? {
              get facts(): typeof ingress.facts {
                throw new Error("Unminted Gateway facts must not be read");
              },
            }
          : ingress;
      const prepared = prepare({
        runId: `gateway-${kind}`,
        boundary: "auto-reply.agent-runner",
        gatewayLocalUserIngress,
      });
      try {
        await prepared.admit("embedded");
        expect(identityWork).toHaveLength(1);
        const captured = identityWork[0];
        expect(captured?.kind).toBe("capture");
        if (captured?.kind !== "capture") {
          throw new Error("Expected the admitted identity envelope");
        }
        expect(captured.envelope.ingress).toEqual(
          kind === "unresolved"
            ? {
                kind: "gateway-client",
                boundary: "gateway.ws.authenticated-connect",
                state: "present",
              }
            : { kind: "channel", boundary: "auto-reply.agent-runner", state: "unknown" },
        );
        expect(captured.envelope.invoker).toEqual({ state: "unknown" });
        expect(captured.envelope.assurance).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "durable-profile" })]),
        );
      } finally {
        prepared.close();
      }
    },
  );

  it("rejects a retired Gateway binding before host tool I/O", async () => {
    const current: { value?: GatewayRequestContext } = {};
    const prepared = prepareChannelRunAdmission({
      cfg: {},
      runId: "run-without-gateway-context",
      agentId: "main",
      ingressKind: "channel",
      boundary: "channel/auto-reply",
      onAdmitted: (context) => bindGatewayContextResolver(context, () => current.value),
    });
    const admittedRunContext = await prepared.admit("plugin-harness", "channel-harness");
    const host = createAgentHarnessHostCapabilities({
      attempt: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-without-gateway-context",
        cwd: "/attempt/worktree",
        workspaceDir: "/workspace",
        currentChannelId: "chat-1",
        messageChannel: "whatsapp",
        admittedRunContext,
      },
      pluginId: "codex",
    });

    try {
      expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
      current.value = {} as GatewayRequestContext;
      expect(() => host.capabilities.assertActive()).toThrow("no longer active");
      await host.runWithScope(async () => {
        expect(getGatewayToolCallerIdentity()?.gatewayContextResolver?.()).toBeUndefined();
        expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
      });
    } finally {
      host.close();
      prepared.close();
      resetAgentRunRegistryForTest();
    }
  });

  it("consumes once across fallback admission and closes the exact prepared owner", async () => {
    const { identityWork, decisions, evidence: createEvidence, prepare } = captureAdmission();
    const admittedContexts: unknown[] = [];
    const evidence = createEvidence();
    const prepared = prepare({
      evidence,
      onAdmitted: (context) => admittedContexts.push(context),
    });

    expect(() => prepared.assertSourceCurrent()).not.toThrow();
    expect(identityWork).toHaveLength(0);
    const first = await prepared.admit("embedded");
    const fallback = await prepared.admit("embedded");

    expect(fallback).toBe(first);
    expect(identityWork).toMatchObject([
      {
        kind: "capture",
        envelope: {
          invoker: { state: "present", kind: "person" },
          assurance: [
            {
              kind: "channel-admission",
              rawEvidenceRef: "channel-admission",
              strength: "boundary-verified",
            },
          ],
        },
      },
    ]);
    expect(decisions).toHaveLength(1);
    expect(admittedContexts).toEqual([first]);
    expect(decisions).toMatchObject([
      {
        decision: { reasonCode: "channel_ingress_attribution_only" },
        enforcement: { policyRefs: [], contextFieldsUsed: [] },
      },
    ]);
    expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
      ingressState: "unknown",
    });

    prepared.close();
    expect(() => prepared.assertSourceCurrent()).not.toThrow();
    await expect(prepared.admit("embedded")).rejects.toThrow(
      "prepared execution context is already closed",
    );
  });

  it("explains identifier-authentication effects alongside an unevaluated contribution", async () => {
    const { decisions, audit, prepare } = captureAdmission();
    const prepared = prepare({
      runId: "run-auth",
      evidence: combineChannelAdmissionEvidence(
        (["affected", "not-evaluated"] as const).map((identifierAuthentication) =>
          createChannelParticipantAdmissionEvidence({
            audit,
            channelId: "test",
            participantId: "private-person-value",
            identifierAuthentication,
          }),
        ),
      ),
    });

    await prepared.admit("embedded");

    expect(decisions).toEqual([
      expect.objectContaining({
        receiptId: expect.stringContaining(":channel-admission"),
        decision: expect.objectContaining({
          reasonCode: "channel_ingress_identifier_authentication_applied",
        }),
        enforcement: expect.objectContaining({
          policyRefs: ["channel.identifier-authentication"],
          contextFieldsUsed: ["channel.identifier-authentication"],
        }),
      }),
    ]);
    expect(JSON.stringify(decisions)).not.toContain("private-person-value");
  });

  it("does not consume a cancelled pre-admission carrier or label internal ACP as a person", async () => {
    const { identityWork, evidence: createEvidence, prepare } = captureAdmission();
    const evidence = createEvidence();
    const cancelled = prepare({
      runId: "cancelled-run",
      evidence,
    });
    cancelled.close();
    await expect(cancelled.admit("embedded")).rejects.toThrow(
      "prepared execution context is already closed",
    );
    expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
      ingressState: "present",
    });

    const internalAcp = prepareAgentRunAdmission({
      cfg: identityConfig,
      operationalRunInstance: createOperationalRunInstanceRef("internal-acp"),
      facts: {
        runId: "internal-acp",
        agentId: "main",
        ingress: { kind: "acp", boundary: "test.internal", state: "present" },
      },
    });
    await internalAcp.admit("acp");
    internalAcp.close();

    expect(identityWork).toHaveLength(1);
    expect(identityWork).toMatchObject([{ kind: "capture", envelope: {} }]);
    const captured = identityWork[0];
    expect(captured?.kind).toBe("capture");
    if (captured?.kind !== "capture") {
      throw new Error("Expected identity capture");
    }
    expect(captured.envelope.invoker).toBeUndefined();
  });
});
