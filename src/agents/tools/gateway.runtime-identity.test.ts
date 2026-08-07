// Gateway tool runtime-identity tests keep current-turn authority fail closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { callGatewayTool, resolveMessageActionAgentRuntimeIdentityToken } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  warn: vi.fn(),
  configState: {
    value: {} as Record<string, unknown>,
  },
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => mocks.configState.value,
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: (...args: unknown[]) => mocks.warn(...args) }),
}));

const LEGACY_APPROVAL_IDENTITY_WARNING =
  "Approval request succeeded without execution attribution because the running Gateway is from an older OpenClaw build. Restart it with `openclaw gateway restart` so future approvals can record attribution.";
const LEGACY_APPROVAL_IDENTITY_WARNING_DEDUPE_KEY = Symbol.for(
  "openclaw.agents.gateway.legacyApprovalIdentityWarning",
);
const EXECUTION_IDENTITY = {
  tokenVersion: 1 as const,
  contextId: "context-1",
  executionId: "execution-1",
  runId: "run-1",
  createdAt: 123,
};

function clearLegacyApprovalIdentityWarningDedupe(): void {
  const cache = (globalThis as Record<PropertyKey, unknown>)[
    LEGACY_APPROVAL_IDENTITY_WARNING_DEDUPE_KEY
  ] as { clear?: () => void } | undefined;
  cache?.clear?.();
}

function capturedGatewayCall(): CallGatewayOptions {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  return mocks.callGateway.mock.calls[0]?.[0] as CallGatewayOptions;
}

describe("gateway tool runtime identity", () => {
  const mintedTurnCapabilities: string[] = [];

  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.warn.mockReset();
    mocks.configState.value = {};
    clearLegacyApprovalIdentityWarningDedupe();
  });

  afterEach(() => {
    clearLegacyApprovalIdentityWarningDedupe();
    for (const token of mintedTurnCapabilities.splice(0)) {
      revokeMessageActionTurnCapability(token);
    }
  });

  it("omits runtime identity outside trusted agent context", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "job-1" });

    await callGatewayTool("cron.remove", {}, { id: "job-1" });

    expect(capturedGatewayCall()).not.toHaveProperty("agentRuntimeIdentityToken");
  });

  it.each([
    ["cron.remove", { id: "job-1" }, { id: "job-1" }],
    ["wake", { mode: "now", text: "ping" }, { ok: true }],
  ] as const)(
    "marks trusted local %s calls with runtime identity",
    async (method, params, result) => {
      mocks.callGateway.mockResolvedValueOnce(result);

      await withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => await callGatewayTool(method, {}, params),
      );

      expect(capturedGatewayCall().agentRuntimeIdentityToken).toEqual(expect.any(String));
    },
  );

  it("signs the exact private execution identity onto local approval creation", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "approval-1" });

    await withGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        executionIdentity: EXECUTION_IDENTITY,
      },
      async () =>
        await callGatewayTool("exec.approval.request", {}, { command: "echo ok", runId: "run-1" }),
    );

    await expect(
      verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken),
    ).resolves.toMatchObject({ executionIdentity: EXECUTION_IDENTITY });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("omits approval execution identity when the private carrier is absent", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "approval-1" });

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: "agent:ops:main" },
      async () =>
        await callGatewayTool("exec.approval.request", {}, { command: "echo ok", runId: "run-1" }),
    );

    expect(capturedGatewayCall()).not.toHaveProperty("agentRuntimeIdentityToken");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("warns once after successful legacy exec and plugin approval retries", async () => {
    const execResult = { id: "sensitive-exec-approval-result" };
    const pluginResult = { id: "sensitive-plugin-approval-result" };
    const staleError = new Error(
      "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
    );
    mocks.callGateway.mockRejectedValueOnce(staleError).mockResolvedValueOnce(execResult);

    const returnedExecResult = await withGatewayToolCallerIdentity(
      {
        agentId: "sensitive-agent",
        sessionKey: "agent:sensitive-agent:main",
        executionIdentity: {
          ...EXECUTION_IDENTITY,
          contextId: "sensitive-context",
          executionId: "sensitive-execution",
          runId: "sensitive-run",
        },
      },
      async () =>
        await callGatewayTool(
          "exec.approval.request",
          {},
          { command: "sensitive-command", runId: "sensitive-run" },
        ),
    );

    expect(returnedExecResult).toBe(execResult);
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway.mock.calls[0]?.[0].agentRuntimeIdentityToken).toEqual(
      expect.any(String),
    );
    expect(mocks.callGateway.mock.calls[1]?.[0].agentRuntimeIdentityToken).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(LEGACY_APPROVAL_IDENTITY_WARNING);

    mocks.callGateway.mockRejectedValueOnce(staleError).mockResolvedValueOnce(pluginResult);
    const returnedPluginResult = await withGatewayToolCallerIdentity(
      {
        agentId: "sensitive-agent",
        sessionKey: "agent:sensitive-agent:main",
        executionIdentity: EXECUTION_IDENTITY,
      },
      async () =>
        await callGatewayTool(
          "plugin.approval.request",
          {},
          { pluginId: "sensitive-plugin", action: "sensitive-action" },
        ),
    );

    expect(returnedPluginResult).toBe(pluginResult);
    expect(mocks.callGateway).toHaveBeenCalledTimes(4);
    expect(mocks.callGateway.mock.calls[3]?.[0].agentRuntimeIdentityToken).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
    const warningPayload = JSON.stringify(mocks.warn.mock.calls);
    for (const sensitiveValue of [
      "sensitive-agent",
      "sensitive-context",
      "sensitive-execution",
      "sensitive-run",
      "sensitive-command",
      "sensitive-plugin",
      "sensitive-action",
      "sensitive-exec-approval-result",
      "sensitive-plugin-approval-result",
    ]) {
      expect(warningPayload).not.toContain(sensitiveValue);
    }
  });

  it("does not warn for node identity compatibility retries", async () => {
    mocks.callGateway
      .mockRejectedValueOnce(
        new Error(
          "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
        ),
      )
      .mockResolvedValueOnce({ ok: true });

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: "agent:ops:main" },
      async () =>
        await callGatewayTool(
          "node.invoke",
          {},
          {
            nodeId: "node-1",
            command: "device.info",
            idempotencyKey: "invoke-legacy",
          },
        ),
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not warn when a legacy approval retry fails", async () => {
    const retryError = new Error("legacy gateway unavailable");
    mocks.callGateway
      .mockRejectedValueOnce(
        new Error(
          "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
        ),
      )
      .mockRejectedValueOnce(retryError);

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:main", executionIdentity: EXECUTION_IDENTITY },
        async () => await callGatewayTool("exec.approval.request", {}, { command: "echo ok" }),
      ),
    ).rejects.toBe(retryError);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not warn for unrelated approval errors", async () => {
    const unrelatedError = new Error("approval request rejected");
    mocks.callGateway.mockRejectedValueOnce(unrelatedError);

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:main", executionIdentity: EXECUTION_IDENTITY },
        async () => await callGatewayTool("exec.approval.request", {}, { command: "echo ok" }),
      ),
    ).rejects.toBe(unrelatedError);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway URL", { gatewayUrl: "ws://127.0.0.1:18789" }, undefined],
    ["gateway token", { gatewayToken: "sensitive-token" }, undefined],
    [
      "configured remote gateway",
      {},
      { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } },
    ],
  ] as const)(
    "does not warn for approval identity suppressed by a %s",
    async (_name, opts, cfg) => {
      mocks.configState.value = cfg ?? {};
      mocks.callGateway.mockResolvedValueOnce({ id: "approval-1" });

      await withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:main", executionIdentity: EXECUTION_IDENTITY },
        async () => await callGatewayTool("exec.approval.request", opts, { command: "echo ok" }),
      );

      expect(capturedGatewayCall()).not.toHaveProperty("agentRuntimeIdentityToken");
      expect(mocks.warn).not.toHaveBeenCalled();
    },
  );

  it("scopes signed session-spawn authority to its Gateway call", async () => {
    mocks.callGateway.mockResolvedValueOnce({ key: "agent:ops:dashboard:child" });

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: "agent:ops:main" },
      async () =>
        await runWithGatewaySessionSpawnContext(
          {
            completionOwnerSessionKey: "agent:ops:discord:direct:alice",
            inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
          },
          () =>
            callGatewayTool(
              "sessions.create",
              {},
              { parentSessionKey: "agent:ops:main", spawnDepth: 1 },
              { requireAgentRuntimeIdentity: true },
            ),
        ),
    );

    await expect(
      verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken),
    ).resolves.toMatchObject({
      sessionSpawnContext: {
        completionOwnerSessionKey: "agent:ops:discord:direct:alice",
        inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
      },
    });
  });

  it("mints message action identity only for an exact admitted source turn", async () => {
    const capabilityInput = {
      agentId: "ops",
      runId: "run-1",
      sessionKey: "agent:ops:telegram:group:room-1",
      sessionId: "session-1",
    };
    const turnCapability = mintMessageActionTurnCapability({
      ...capabilityInput,
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "room-1",
        currentChatType: "group",
        currentSourceTurnId: "source-turn-1",
      },
    });
    const sourceLessTurnCapability = mintMessageActionTurnCapability({
      ...capabilityInput,
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "room-1",
        currentChatType: "group",
      },
    });
    mintedTurnCapabilities.push(turnCapability, sourceLessTurnCapability);
    const terminalParams = {
      opts: {},
      target: "local" as const,
      runId: "run-1",
      sessionId: "session-1",
      sourceReplyFinal: true,
      sourceReplyToolCallId: "message-call-1",
    };

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: capabilityInput.sessionKey },
      async () => {
        const token = await resolveMessageActionAgentRuntimeIdentityToken({
          ...terminalParams,
          turnCapability,
        });
        await expect(verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
          messageActionContext: {
            sessionId: "session-1",
            sourceReplyFinal: true,
            sourceReplyToolCallId: "message-call-1",
            requesterAccountId: "default",
            toolContext: { currentSourceTurnId: "source-turn-1" },
          },
        });
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            sourceReplyToolCallId: undefined,
            turnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires tool-call correlation");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            turnCapability: "missing-capability",
          }),
        ).rejects.toThrow("terminal source reply requires an active turn capability");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            turnCapability: sourceLessTurnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires source-turn correlation");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            target: "remote",
            turnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires the trusted local gateway context");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            target: "remote",
            turnCapability,
            callerOwnsTerminalReceipt: true,
          }),
        ).resolves.toBeUndefined();
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({ opts: {}, target: "local" }),
        ).resolves.toBeUndefined();
      },
    );
    await expect(
      resolveMessageActionAgentRuntimeIdentityToken({ ...terminalParams, turnCapability }),
    ).rejects.toThrow("terminal source reply requires trusted agent runtime identity");
  });
});
