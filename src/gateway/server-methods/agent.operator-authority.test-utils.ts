// Imported by agent.test.ts to prove authenticated operator authority at Gateway admission.
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  createSteeringAuthorizationAffinity,
  resolveSteeringAuthorizationAffinityKey,
} from "../../auto-reply/reply/steering-authorization-affinity.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import {
  createTurnAuthoritySnapshot,
  isIssuedTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../../sessions/session-lifecycle-admission.js";
import {
  describe0AfterEach0,
  expectRespondError,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  primeMainAgentRun,
  waitForAgentCommandCall,
  type AgentHandlerArgs,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

function createOperatorClient(params: {
  connId: string;
  scopes: string[];
  pairedClientId: string;
  deviceId?: string;
  mode?: "backend" | "ui";
}): NonNullable<AgentHandlerArgs["client"]> {
  return {
    connId: params.connId,
    pairedClientId: params.pairedClientId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: params.mode ?? "ui",
      },
      scopes: params.scopes,
      ...(params.deviceId
        ? {
            device: {
              id: params.deviceId,
              publicKey: "test-public-key",
              signature: "test-signature",
              signedAt: 1,
              nonce: "test-nonce",
            },
          }
        : {}),
    },
  } as NonNullable<AgentHandlerArgs["client"]>;
}

describe("gateway agent operator authority", () => {
  afterEach(describe0AfterEach0);

  it.each([
    {
      label: "write-scoped paired device",
      scopes: ["operator.write"],
      deviceId: "device-writer",
      expectedControllerKey: "device:device-writer",
      expectedOwner: false,
    },
    {
      label: "admin connection without a device",
      scopes: ["operator.admin", "operator.write"],
      deviceId: undefined,
      expectedControllerKey: "connection:conn-admin-connection-without-a-device",
      expectedOwner: true,
    },
  ])(
    "issues immutable authority for $label",
    async ({ label, scopes, deviceId, expectedControllerKey, expectedOwner }) => {
      const runId = `operator-authority-${label.replaceAll(" ", "-")}`;
      const sessionId = "operator-authority-session";
      const connId = `conn-${label.replaceAll(" ", "-")}`;
      const pairedClientId = `paired-${label.replaceAll(" ", "-")}`;
      const client = createOperatorClient({ connId, scopes, pairedClientId, deviceId });
      const context = makeContext();
      primeMainAgentRun({ sessionId });
      let finishAgentCommand:
        | ((value: { payloads: Array<{ text: string }>; meta: { durationMs: number } }) => void)
        | undefined;
      mocks.agentCommand.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishAgentCommand = resolve;
          }),
      );

      try {
        await invokeAgent(
          {
            message: "inspect the incident",
            agentId: "main",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { client, context },
        );

        const call = await waitForAgentCommandCall<{
          senderIsOwner?: boolean;
          turnAuthority?: TurnAuthoritySnapshot;
        }>();
        expect(isIssuedTurnAuthoritySnapshot(call.turnAuthority)).toBe(true);
        expect(Object.isFrozen(call.turnAuthority)).toBe(true);
        expect(Object.isFrozen(call.turnAuthority?.authorization)).toBe(true);
        expect(Object.isFrozen(call.turnAuthority?.authorization.principal)).toBe(true);
        expect(call.turnAuthority).toMatchObject({
          authorization: {
            principal: {
              kind: "operator",
              scopes,
              clientId: pairedClientId,
              ...(deviceId ? { deviceId } : {}),
              isOwner: expectedOwner,
            },
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionId,
            runId,
            conversationId: "agent:main:main",
            trigger: "gateway",
          },
          controllerKey: expectedControllerKey,
        });
        expect(call.senderIsOwner).toBe(expectedOwner);
        const activeEntry = context.chatAbortControllers.get(runId);
        expect(activeEntry).toBeDefined();
        expect(
          resolveSteeringAuthorizationAffinityKey(activeEntry?.steeringAuthorizationAffinity),
        ).toBe(
          resolveSteeringAuthorizationAffinityKey(
            createSteeringAuthorizationAffinity({ turnAuthority: call.turnAuthority }),
          ),
        );
      } finally {
        finishAgentCommand?.({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      }
    },
  );

  it.each([
    { label: "plain runtime identity", cronRunContinuation: false },
    { label: "unvalidated cron continuation claim", cronRunContinuation: true },
  ])(
    "does not promote $label to operator authority from connection scopes",
    async ({ label, cronRunContinuation }) => {
      const client = createOperatorClient({
        connId: `conn-${label.replaceAll(" ", "-")}`,
        scopes: ["operator.admin", "operator.write"],
        pairedClientId: `paired-${label.replaceAll(" ", "-")}`,
        mode: "backend",
      });
      client.internal = {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayMethods: ["agent"],
        },
        ...(cronRunContinuation ? { cronRunContinuation: true } : {}),
      };
      primeMainAgentRun({ sessionId: "runtime-principal-session" });
      mocks.agentCommand.mockClear();
      mocks.performGatewaySessionReset.mockClear();

      const respond = await invokeAgent(
        {
          message: cronRunContinuation ? "inspect the incident" : "/reset",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: `runtime-principal-${label.replaceAll(" ", "-")}`,
        },
        { client, flushDispatch: false },
      );

      expectRespondError(respond, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "agent runtime identity requires validated turn delegation",
      });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    },
  );

  it("fails closed when an adopted admission carries conflicting legacy owner authority", async () => {
    const runId = "operator-authority-conflicting-admission";
    const sessionKey = "agent:main:main";
    const sessionId = "operator-authority-conflicting-session";
    primeMainAgentRun({ sessionId });
    mocks.agentCommand.mockClear();
    const admission = await beginSessionWorkAdmission({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    expect(
      admission.setTurnAuthority(
        createTurnAuthoritySnapshot({
          principal: {
            kind: "sender",
            provider: "discord",
            senderId: "legacy-owner",
            senderIsOwner: true,
          },
          agentId: "main",
          sessionKey,
          sessionId,
          runId: "legacy-run",
          conversationId: sessionKey,
          trigger: "channel",
          controllerKey: "sender:legacy-owner",
        }),
      ),
    ).toBe(true);
    const handoffId = admission.createHandoff();

    try {
      const respond = await invokeAgent(
        {
          message: "inspect the incident",
          agentId: "main",
          sessionKey,
          expectedExistingSessionId: sessionId,
          internalRuntimeHandoffId: handoffId,
          idempotencyKey: runId,
        },
        {
          client: createOperatorClient({
            connId: "conn-conflicting-admission",
            scopes: ["operator.admin"],
            pairedClientId: "paired-conflicting-admission",
            mode: "backend",
          }),
          flushDispatch: false,
        },
      );

      expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    } finally {
      cancelSessionWorkAdmissionHandoff(handoffId);
      admission.release();
    }
  });
});
