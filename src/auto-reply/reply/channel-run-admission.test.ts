import { assert, expect, it, onTestFinished } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
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

function prepare(params: Partial<Parameters<typeof prepareChannelRunAdmission>[0]> = {}) {
  const prepared = prepareChannelRunAdmission({
    cfg: identityConfig,
    runId: "run-1",
    agentId: "main",
    ingressKind: "channel",
    boundary: "test.channel",
    ...params,
  });
  onTestFinished(() => prepared.close());
  return prepared;
}

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
  const envelope = () => {
    expect(identityWork).toHaveLength(1);
    const captured = identityWork[0];
    assert(captured?.kind === "capture", "Expected identity capture");
    return captured.envelope;
  };
  return { identityWork, decisions, audit, evidence, envelope };
}

it.each(["unresolved", "forged"] as const)(
  "records only owner-prepared Gateway facts for a %s carrier",
  async (kind) => {
    const { envelope } = captureAdmission();
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
      boundary: "auto-reply.agent-runner",
      gatewayLocalUserIngress,
    });
    await prepared.admit("embedded");
    const captured = envelope();
    expect(captured.ingress).toEqual(
      kind === "unresolved"
        ? {
            kind: "gateway-client",
            boundary: "gateway.ws.authenticated-connect",
            state: "present",
          }
        : { kind: "channel", boundary: "auto-reply.agent-runner", state: "unknown" },
    );
    expect(captured.invoker).toEqual({ state: "unknown" });
    expect(captured.assurance).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "durable-profile" })]),
    );
  },
);

it("rejects a retired Gateway binding before host tool I/O", async () => {
  const runId = "run-without-gateway-context";
  const current: { value?: GatewayRequestContext } = {};
  const prepared = prepare({
    cfg: {},
    runId,
    onAdmitted: (context) => bindGatewayContextResolver(context, () => current.value),
  });
  const admittedRunContext = await prepared.admit("plugin-harness", "channel-harness");
  const host = createAgentHarnessHostCapabilities({
    attempt: { runId, admittedRunContext },
    pluginId: "codex",
  });

  onTestFinished(() => {
    host.close();
    resetAgentRunRegistryForTest();
  });
  expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
  current.value = {} as GatewayRequestContext;
  expect(() => host.capabilities.assertActive()).toThrow("no longer active");
  await host.runWithScope(async () => {
    expect(getGatewayToolCallerIdentity()?.gatewayContextResolver?.()).toBeUndefined();
    expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
  });
});

it("consumes once across fallback admission and closes the exact prepared owner", async () => {
  const { identityWork, decisions, evidence: createEvidence, envelope } = captureAdmission();
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
  expect(envelope()).toMatchObject({
    invoker: { state: "present", kind: "person" },
    assurance: [
      {
        kind: "channel-admission",
        rawEvidenceRef: "channel-admission",
        strength: "boundary-verified",
      },
    ],
  });
  expect(admittedContexts).toEqual([first]);
  expect(decisions).toMatchObject([
    {
      decision: { reasonCode: "channel_ingress_attribution_only" },
      enforcement: { policyRefs: [], contextFieldsUsed: [] },
    },
  ]);
  expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({ ingressState: "unknown" });

  prepared.close();
  expect(() => prepared.assertSourceCurrent()).not.toThrow();
  await expect(prepared.admit("embedded")).rejects.toThrow(
    "prepared execution context is already closed",
  );
});

it("explains identifier-authentication effects alongside an unevaluated contribution", async () => {
  const { decisions, audit } = captureAdmission();
  const prepared = prepare({
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

  expect(decisions).toMatchObject([
    {
      receiptId: expect.stringContaining(":channel-admission"),
      decision: { reasonCode: "channel_ingress_identifier_authentication_applied" },
      enforcement: {
        policyRefs: ["channel.identifier-authentication"],
        contextFieldsUsed: ["channel.identifier-authentication"],
      },
    },
  ]);
  expect(JSON.stringify(decisions)).not.toContain("private-person-value");
});

it("does not consume a cancelled pre-admission carrier", async () => {
  const { evidence: createEvidence } = captureAdmission();
  const evidence = createEvidence();
  const cancelled = prepare({ runId: "cancelled-run", evidence });
  cancelled.close();
  await expect(cancelled.admit("embedded")).rejects.toThrow(
    "prepared execution context is already closed",
  );
  expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({ ingressState: "present" });
});
