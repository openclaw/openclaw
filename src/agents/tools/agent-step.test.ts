// Agent step tests cover nested session handoff, transcript bookkeeping, and
// MCP runtime retirement after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { runAgentStep } from "./agent-step.js";
import { testing } from "./agent-step.test-support.js";

const runtimeIdentityMocks = vi.hoisted(() => {
  const runtimeIdentity = ["signed", "agent", "runtime"].join("-");
  const mintRuntimeIdentity = vi.fn(async (_params: unknown) => runtimeIdentity);
  return { mintRuntimeIdentity, runtimeIdentity };
});

const runWaitMocks = vi.hoisted(() => ({
  waitForAgentRunAndReadUpdatedAssistantReply: vi.fn(),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForAgentSessionKey: vi.fn(async () => true),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRunAndReadUpdatedAssistantReply:
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply,
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForAgentSessionKey:
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey,
}));

vi.mock("../../gateway/agent-runtime-identity-token.js", () => ({
  async mintAgentRuntimeIdentityToken(params: unknown) {
    return await runtimeIdentityMocks.mintRuntimeIdentity(params);
  },
}));

function createTestTurnAuthority(params?: {
  agentId?: string;
  sessionKey?: string;
}): TurnAuthoritySnapshot {
  return createTurnAuthoritySnapshot({
    principal: {
      kind: "sender",
      provider: "discord",
      senderId: "maintainer",
      senderIsOwner: false,
      isAuthorizedSender: true,
      roleIds: ["maintainers"],
    },
    agentId: params?.agentId ?? "main",
    sessionKey: params?.sessionKey ?? "agent:main:discord:channel:maintenance",
    sessionId: "source-session-id",
    runId: "source-run-id",
    conversationId: "maintenance",
    trigger: "message",
  });
}

describe("runAgentStep", () => {
  afterEach(() => {
    testing.setDepsForTest();
    vi.clearAllMocks();
  });

  it("retires bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-nested" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });
    const turnAuthority = createTestTurnAuthority();

    await expect(
      runAgentStep({
        sessionKey: "agent:worker:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        sourceSessionKey: "agent:main:discord:channel:maintenance",
        sourceChannel: "discord",
        turnAuthority,
      }),
    ).resolves.toBe("done");

    const gatewayCall = gatewayCalls[0];
    const params = gatewayCall?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:worker:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:worker:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        targetAgentId: "worker",
        targetSessionKey: "agent:worker:subagent:child",
        request: gatewayCall?.params,
        turnAuthority,
      },
    });
    expect(gatewayCall).toMatchObject({
      method: "agent",
      timeoutMs: 10_000,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "agent",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.write"],
      requireLocalBackendSharedAuth: true,
    });
    expect(gatewayCall?.agentRuntimeIdentityToken).toBe(runtimeIdentityMocks.runtimeIdentity);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey).toHaveBeenCalledWith({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:child",
      reason: "nested-agent-step-complete",
    });
  });

  it("does not retire bundle MCP runtime while nested agent steps are still pending", async () => {
    testing.setDepsForTest({
      callGateway: async <T = unknown>(): Promise<T> => ({ runId: "run-pending" }) as T,
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "timeout",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority(),
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey).not.toHaveBeenCalled();
  });

  it("binds an unscoped global target to its explicit agent", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-global" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "global done",
    });

    await expect(
      runAgentStep({
        sessionKey: "global",
        targetAgentId: "work",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority({ agentId: "work", sessionKey: "global" }),
      }),
    ).resolves.toBe("global done");

    expect(gatewayCalls[0]?.params).toMatchObject({ sessionKey: "global", agentId: "work" });
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        sessionKey: "global",
        sessionsSendDelegation: expect.objectContaining({
          targetAgentId: "work",
          targetSessionKey: "global",
          request: gatewayCalls[0]?.params,
        }),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: "global",
      reason: "nested-agent-step-complete",
    });
  });

  it("binds a custom unscoped target to its explicit agent", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-custom" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "custom done",
    });

    await expect(
      runAgentStep({
        sessionKey: "custom-ops-session",
        targetAgentId: "ops",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority(),
      }),
    ).resolves.toBe("custom done");

    expect(gatewayCalls[0]?.params).toMatchObject({
      sessionKey: "custom-ops-session",
      agentId: "ops",
      lane: "nested:agent:ops:custom-ops-session",
    });
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsSendDelegation: expect.objectContaining({
          targetAgentId: "ops",
          targetSessionKey: "custom-ops-session",
          request: gatewayCalls[0]?.params,
        }),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey).toHaveBeenCalledWith({
      agentId: "ops",
      sessionKey: "custom-ops-session",
      reason: "nested-agent-step-complete",
    });
  });

  it("rejects an unscoped target without an explicit agent", async () => {
    const callGatewayMock = vi.fn();
    testing.setDepsForTest({ callGateway: callGatewayMock });

    await expect(
      runAgentStep({
        sessionKey: "global",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority(),
      }),
    ).rejects.toThrow("unscoped target requires an explicit agent id");

    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("routes transcript-mode bookkeeping through signed Gateway admission", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-nested" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await runAgentStep({
      sessionKey: "agent:main:subagent:child",
      message: "internal announce step",
      transcriptMessage: "",
      extraSystemPrompt: "announce only",
      timeoutMs: 30_000,
      turnAuthority: createTestTurnAuthority(),
    });

    expect(gatewayCalls).toHaveLength(1);
    const request = gatewayCalls[0]?.params as Record<string, unknown>;
    expect(request.message).toContain("internal announce step");
    expect(request.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(request.suppressPromptPersistence).toBe(true);
    expect(request).not.toHaveProperty("transcriptMessage");
    expect(gatewayCalls[0]).toMatchObject({
      method: "agent",
      timeoutMs: 30_000,
      requireLocalBackendSharedAuth: true,
      expectFinal: true,
    });
    expect(gatewayCalls[0]?.agentRuntimeIdentityToken).toBe(runtimeIdentityMocks.runtimeIdentity);
    const mintParams = runtimeIdentityMocks.mintRuntimeIdentity.mock.calls[0]?.[0] as
      | { sessionsSendDelegation?: Record<string, unknown> }
      | undefined;
    expect(mintParams?.sessionsSendDelegation).not.toHaveProperty("transcriptMessage");
    expect(runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply).not.toHaveBeenCalled();
  });

  it("carries non-empty transcript text through signed Gateway admission", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-transcript" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });
    const turnAuthority = createTestTurnAuthority();

    await runAgentStep({
      sessionKey: "agent:worker:subagent:child",
      message: "runtime-only bookkeeping context",
      transcriptMessage: "canonical user-visible transcript",
      extraSystemPrompt: "reply briefly",
      timeoutMs: 10_000,
      turnAuthority,
    });

    const request = gatewayCalls[0]?.params as Record<string, unknown>;
    expect(request).not.toHaveProperty("transcriptMessage");
    expect(request).not.toHaveProperty("suppressPromptPersistence");
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsSendDelegation: expect.objectContaining({
          request,
          transcriptMessage: "canonical user-visible transcript",
          turnAuthority,
        }),
      }),
    );
  });

  it("does not return failed transcript-mode output as an announce reply", async () => {
    testing.setDepsForTest({
      callGateway: async <T = unknown>(): Promise<T> =>
        ({
          runId: "run-failed",
          result: {
            meta: { error: { kind: "incomplete_turn", terminalPresentation: false } },
            payloads: [{ text: "⚠️ Agent couldn't generate a response. Please try again." }],
          },
        }) as T,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "internal announce step",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority(),
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForAgentSessionKey).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:subagent:child",
      reason: "nested-agent-step-complete",
    });
    expect(runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply).not.toHaveBeenCalled();
  });

  it("returns successful transcript-mode output", async () => {
    const presentation =
      "The read-only lookup completed successfully.\n\n⚠️ Agent couldn't generate a response. Please try again.";
    testing.setDepsForTest({
      callGateway: async <T = unknown>(): Promise<T> =>
        ({
          runId: "run-success",
          result: {
            meta: { error: { kind: "incomplete_turn", terminalPresentation: true } },
            payloads: [{ text: presentation }],
          },
        }) as T,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "internal announce step",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
        turnAuthority: createTestTurnAuthority(),
      }),
    ).resolves.toBe(presentation);
    expect(runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    [
      "forged",
      {
        authorization: {
          principal: { kind: "service", serviceId: "forged" },
          agentId: "main",
          sessionKey: "agent:main:discord:channel:maintenance",
        },
      } as TurnAuthoritySnapshot,
    ],
  ])("fails closed for %s turn authority", async (_label, turnAuthority) => {
    const callGatewayMock = vi.fn();
    testing.setDepsForTest({ callGateway: callGatewayMock });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority,
      }),
    ).rejects.toThrow("nested sessions_send agent step requires trusted turn authority");

    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("fails closed when issued authority is not bound to a source session", async () => {
    const callGatewayMock = vi.fn();
    testing.setDepsForTest({ callGateway: callGatewayMock });
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "service", serviceId: "agent-runtime" },
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        turnAuthority,
      }),
    ).rejects.toThrow("nested sessions_send agent step requires bound source authority");

    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
