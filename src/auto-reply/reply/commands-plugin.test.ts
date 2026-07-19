// Tests plugin command dispatch and plugin-scoped command aliases.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthorizationPolicyHandler } from "../../plugins/authorization-policy.types.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOperatorTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";

const matchPluginCommandMock = vi.hoisted(() => vi.fn());
const executePluginCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/commands.js", () => ({
  matchPluginCommand: matchPluginCommandMock,
  executePluginCommand: executePluginCommandMock,
  executePluginCommandWithTurnAuthority: executePluginCommandMock,
}));

function buildPluginParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      GatewayClientScopes: ["operator.write", "operator.pairing"],
      AccountId: undefined,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      from: "test-user",
      to: "test-bot",
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
  } as unknown as HandleCommandsParams;
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("dispatches registered plugin commands with gateway scopes and session metadata", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("from plugin");
    expect(executePluginCommandMock).toHaveBeenCalledTimes(1);
    const [commandParams] = expectDefined(
      (
        executePluginCommandMock.mock.calls as unknown as Array<
          [
            {
              gatewayClientScopes?: string[];
              sessionKey?: string;
              sessionId?: string;
              commandBody?: string;
            },
          ]
        >
      )[0],
      "(executePluginCommandMock.mock.calls as unknown as Array<\n        [\n          {\n            gatewayClientScopes?: string[];\n            sessionKey?: string;\n            sessionId?: string;\n            commandBody?: string;\n          },\n        ]\n      >)[0] test invariant",
    );
    expect(commandParams.gatewayClientScopes).toEqual(["operator.write", "operator.pairing"]);
    expect(commandParams.sessionKey).toBe("agent:main:whatsapp:direct:test-user");
    expect(commandParams.sessionId).toBe("session-plugin-command");
    expect(commandParams.commandBody).toBe("/card");
  });

  it("passes immutable turn authority to host plugin command execution", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    const turnAuthority = createOperatorTurnAuthoritySnapshot({
      scopes: ["operator.write"],
      pairedClientId: "control-ui",
      connectionId: "connection-1",
      agentId: "main",
      sessionKey: params.sessionKey,
      trigger: "gateway",
    });
    params.ctx.TurnAuthority = turnAuthority;

    await handlePluginCommand(params, true);

    expect(executePluginCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ turnAuthority }),
    );
  });

  it("passes transport-native conversation ids separately from routing targets", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    params.ctx.NativeChannelId = "thread-native";
    params.ctx.OriginatingTo = "discord:channel:thread-native";
    params.ctx.ThreadParentId = "maintenance-native";
    params.ctx.MessageThreadId = "thread-native";

    await handlePluginCommand(params, true);

    expect(executePluginCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "thread-native",
        parentConversationId: "maintenance-native",
        messageThreadId: "thread-native",
      }),
    );
  });

  it("denies a plugin command scoped to a Slack transport-only thread", async () => {
    const actualCommands = await vi.importActual<typeof import("../../plugins/commands.js")>(
      "../../plugins/commands.js",
    );
    const handler = vi.fn().mockResolvedValue({ text: "executed" });
    matchPluginCommandMock.mockReturnValue({
      command: {
        pluginId: "maintenance-plugin",
        pluginName: "Maintenance Plugin",
        pluginRoot: "/tmp/maintenance-plugin",
        name: "maintain",
        description: "Run maintenance",
        handler,
      },
      args: "",
    });
    executePluginCommandMock.mockImplementation(
      actualCommands.executePluginCommandWithTurnAuthority,
    );
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request, context) =>
      request.commandName === "maintain" &&
      context.principal.kind === "sender" &&
      context.principal.provider === "slack" &&
      context.threadId === "1712345678.000100"
        ? { effect: "deny", code: "thread-plugin-denied" }
        : { effect: "pass" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "thread-access",
        description: "Protect Slack thread plugin commands",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);
    const params = buildPluginParams("/maintain", {
      commands: { text: true },
    } as OpenClawConfig);
    params.ctx.Provider = "slack";
    params.ctx.Surface = "slack";
    params.ctx.AccountId = "default";
    params.ctx.NativeChannelId = "CMAINTENANCE";
    params.ctx.OriginatingTo = "channel:CMAINTENANCE";
    params.ctx.ThreadParentId = "CMAINTENANCE";
    params.ctx.MessageThreadId = undefined;
    params.ctx.TransportThreadId = "1712345678.000100";
    params.command.surface = "slack";
    params.command.channel = "slack";
    params.command.channelId = "slack";
    params.command.from = "slack:channel:CMAINTENANCE";
    params.command.to = "slack:channel:CMAINTENANCE";

    const result = await handlePluginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Command blocked by authorization policy." },
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "maintain" }),
      expect.objectContaining({ threadId: "1712345678.000100" }),
      expect.any(AbortSignal),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("prefers the target session entry from sessionStore for plugin command metadata", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

    const params = buildPluginParams("/card", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.sessionEntry = {
      sessionId: "wrapper-session",
      sessionFile: "/tmp/wrapper-session.jsonl",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
        authProfileOverride: "openai:owner@example.com",
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    expect(executePluginCommandMock).toHaveBeenCalledTimes(1);
    const [commandParams] = expectDefined(
      (
        executePluginCommandMock.mock.calls as unknown as Array<
          [{ authProfileId?: string; sessionId?: string; sessionFile?: string }]
        >
      )[0],
      "(executePluginCommandMock.mock.calls as unknown as Array<\n        [{ authProfileId?: string; sessionId?: string; sessionFile?: string }]\n      >)[0] test invariant",
    );
    expect(commandParams.sessionId).toBe("target-session");
    expect(commandParams.sessionFile).toBe("/tmp/target-session.jsonl");
    expect(commandParams.authProfileId).toBe("openai:owner@example.com");
  });

  it("continues the agent without leaking continueAgent into the reply payload", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({
      text: "from plugin",
      continueAgent: true,
    });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toEqual({
      shouldContinue: true,
      reply: { text: "from plugin" },
    });
  });

  it("enforces requiredScopes through the command handler path", async () => {
    const actualCommands = await vi.importActual<typeof import("../../plugins/commands.js")>(
      "../../plugins/commands.js",
    );
    const handler = vi.fn().mockResolvedValue({
      text: "approved",
      continueAgent: true,
    });
    const command = {
      pluginId: "approval-plugin",
      pluginName: "Approval Plugin",
      pluginRoot: "/tmp/approval-plugin",
      name: "approve-deploy",
      description: "Approve deployment",
      requiredScopes: ["operator.approvals"],
      handler,
    };
    matchPluginCommandMock.mockReturnValue({
      command,
      args: "",
    });
    executePluginCommandMock.mockImplementation(actualCommands.executePluginCommand);

    const denied = await handlePluginCommand(
      buildPluginParams("/approve-deploy", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(denied).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ This command requires gateway scope: operator.approvals." },
    });
    expect(handler).not.toHaveBeenCalled();

    const allowedParams = buildPluginParams("/approve-deploy", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    allowedParams.ctx.GatewayClientScopes = ["operator.approvals"];

    const allowed = await handlePluginCommand(allowedParams, true);

    expect(allowed).toEqual({
      shouldContinue: true,
      reply: { text: "approved" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
