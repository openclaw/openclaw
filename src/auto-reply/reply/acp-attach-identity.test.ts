import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  AcpRunTurnInput,
  AcpSessionResolution,
} from "../../acp/control-plane/manager.types.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../../gateway/local-user-ingress.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleAcpCommand } from "./commands-acp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { runDispatch } from "./dispatch-acp.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const manager = vi.hoisted(() => ({
  resolveSessionAsync: vi.fn<() => Promise<AcpSessionResolution>>(),
  runTurn: vi.fn<(input: AcpRunTurnInput) => Promise<void>>(),
  getObservabilitySnapshot: () => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  }),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => manager,
}));

vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: async () => undefined,
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({ resolveByConversationAsync: async () => null }),
}));

const sessionKey = "agent:main:acp:attach-identity";
const cfg = createAcpTestConfig({ logging: { audit: { executionIdentity: true } } });

beforeEach(() => {
  manager.resolveSessionAsync.mockReset().mockResolvedValue({
    kind: "ready",
    sessionKey,
    agentId: "main",
    meta: createAcpSessionMeta(),
  });
  manager.runTurn.mockReset().mockImplementation(async ({ onEvent }) => {
    await onEvent?.({ type: "done" });
  });
});

it.each(["message", "steer"] as const)(
  "retains the original Gateway attach identity through ACP %s admission",
  async (mode) => {
    const captured: ExecutionIdentityAdmissionWork[] = [];
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    onTestFinished(clearSink);
    const body = mode === "message" ? "keep going" : "/acp steer keep going";
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      SessionKey: sessionKey,
      GatewayClientScopes: ["operator.admin"],
    });
    attachGatewayLocalUserIngress(
      ctx,
      prepareGatewayLocalUserIngress({
        authMethod: "token",
        authenticatedUserExpected: true,
        profile: { profileId: "a", displayName: "A" },
        isLocalClient: false,
      }),
    );
    ctx.SenderId = "b";
    ctx.SenderName = "B";

    if (mode === "message") {
      const recordProcessed = vi.fn();
      await runDispatch({
        bodyForAgent: body,
        cfg,
        ctx,
        sessionKeyOverride: sessionKey,
        recordProcessed,
      });
      expect(recordProcessed).toHaveBeenCalledWith("completed", { reason: "acp_dispatch" });
    } else {
      // Command processing copies public fields; attach evidence remains on the original context.
      const params = Object.assign(buildCommandTestParams(body, cfg, ctx), {
        sessionKey,
        rootCtx: ctx,
      });
      const result = await handleAcpCommand(params, true);
      expect(result?.reply?.text).toContain(`ACP steer sent to ${sessionKey}`);
    }

    expect(manager.runTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        mode: mode === "message" ? "prompt" : "steer",
        text: "keep going",
      }),
    );
    expect(captured).toMatchObject([
      {
        kind: "capture",
        envelope: {
          runtime: { kind: "acp" },
          ingress: {
            kind: "gateway-client",
            boundary: "gateway.ws.authenticated-connect",
            state: "present",
          },
          invoker: { state: "present", kind: "person", rawPrincipalRef: "a", displayLabel: "A" },
          assurance: [
            { kind: "durable-profile", rawEvidenceRef: "a", strength: "boundary-verified" },
          ],
        },
      },
    ]);
  },
);
