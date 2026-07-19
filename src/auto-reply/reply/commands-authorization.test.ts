import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationPolicyHandler } from "../../plugins/authorization-policy.types.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOperatorTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import type { MsgContext } from "../templating.js";
import {
  authorizeCoreCommand,
  authorizeCoreCommandName,
  shouldAuthorizeCoreCommandTurn,
} from "./commands-authorization.js";
import { buildCommandContext } from "./commands-context.js";
import type { CommandContext } from "./commands-types.js";

function command(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    surface: "discord",
    channel: "discord",
    channelId: "discord",
    accountId: "default",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: true,
    senderId: "maintainer-1",
    memberRoleIds: ["maintainers"],
    rawBodyNormalized: "/restart",
    commandBodyNormalized: "/restart",
    from: "discord:channel:maintenance",
    to: "discord:channel:maintenance",
    ...overrides,
  };
}

function context(): MsgContext {
  return {
    Provider: "discord",
    AccountId: "default",
    SenderId: "maintainer-1",
    NativeChannelId: "maintenance",
    OriginatingTo: "channel:maintenance",
    MessageThreadId: "thread-1",
    ThreadParentId: "maintenance",
    CommandSource: "native",
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("core command authorization", () => {
  it("uses the immutable Gateway operator authority for admin and write callers", async () => {
    const seen: unknown[] = [];
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((_request, auth) => {
      seen.push(auth.principal);
      return { effect: "pass" };
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "operator-access",
      source: "test",
      policy: {
        id: "operator-access",
        description: "Capture operator authority",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);

    for (const [scope, connectionId] of [
      ["operator.admin", "admin-conn"],
      ["operator.write", "write-conn"],
    ] as const) {
      const ctx = context();
      ctx.TurnAuthority = createOperatorTurnAuthoritySnapshot({
        scopes: [scope],
        pairedClientId: "paired-ui",
        connectionId,
        isOwner: scope === "operator.admin",
        agentId: "main",
        sessionKey: "agent:main:main",
        trigger: "gateway",
      });
      await authorizeCoreCommand({ command: command(), ctx, agentId: "main" });
    }

    expect(seen).toEqual([
      {
        kind: "operator",
        scopes: ["operator.admin"],
        clientId: "paired-ui",
        isOwner: true,
      },
      {
        kind: "operator",
        scopes: ["operator.write"],
        clientId: "paired-ui",
        isOwner: false,
      },
    ]);
  });

  it("rebinds immutable authority to the canonical command target", async () => {
    const seen: unknown[] = [];
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((_request, auth) => {
      seen.push(auth);
      return { effect: "pass" };
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "operator-access",
      source: "test",
      policy: {
        id: "operator-access",
        description: "Capture canonical command target",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = context();
    const sourceAuthority = createOperatorTurnAuthoritySnapshot({
      scopes: ["operator.write"],
      pairedClientId: "paired-ui",
      connectionId: "writer-conn",
      agentId: "source-agent",
      sessionKey: "agent:source-agent:source",
      sessionId: "source-session",
      runId: "source-run",
      conversationId: "maintenance",
      parentConversationId: "maintenance-parent",
      threadId: "thread-1",
      trigger: "gateway",
    });
    ctx.TurnAuthority = sourceAuthority;

    await authorizeCoreCommandName({
      command: command(),
      ctx,
      commandName: "restart",
      agentId: "target-agent",
      sessionKey: "agent:target-agent:maintenance",
      sessionId: "target-session",
      runId: "command-run",
    });

    expect(seen).toEqual([
      {
        ...sourceAuthority.authorization,
        agentId: "target-agent",
        sessionKey: "agent:target-agent:maintenance",
        sessionId: "target-session",
        runId: "command-run",
        trigger: "command",
      },
    ]);
    expect(sourceAuthority.authorization).toMatchObject({
      agentId: "source-agent",
      sessionKey: "agent:source-agent:source",
      sessionId: "source-session",
      runId: "source-run",
      trigger: "gateway",
    });
  });

  it("does not fall back to mutable sender facts for an unissued authority snapshot", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "sender-access",
        description: "Capture any legacy fallback",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = context();
    ctx.TurnAuthority = {
      authorization: {
        principal: {
          kind: "operator",
          scopes: ["operator.write"],
        },
      },
    };

    const result = await authorizeCoreCommand({
      command: command({ senderIsOwner: true }),
      ctx,
      agentId: "main",
    });

    expect(result).toMatchObject({
      matched: true,
      allowed: false,
      denial: { code: "turn-authority-invalid" },
    });
    expect(
      buildCommandContext({
        ctx,
        cfg: {},
        agentId: "main",
        isGroup: false,
        triggerBodyNormalized: "/restart",
        commandAuthorized: true,
      }),
    ).toMatchObject({
      senderId: undefined,
      senderIsOwner: false,
      isAuthorizedSender: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips disabled ordinary text commands but keeps host-handled controls protected", () => {
    expect(
      shouldAuthorizeCoreCommandTurn({
        allowTextCommands: false,
        commandBodyNormalized: "/status",
      }),
    ).toBe(false);
    for (const commandBodyNormalized of ["/new", "/reset soft", "/stop"]) {
      expect(
        shouldAuthorizeCoreCommandTurn({ allowTextCommands: false, commandBodyNormalized }),
      ).toBe(true);
    }
  });

  it("passes canonical command and host sender identity to policy", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(
      (_request, authorizationContext) =>
        authorizationContext.principal.kind === "sender" &&
        authorizationContext.principal.senderIsOwner
          ? { effect: "pass" as const }
          : {
              effect: "deny" as const,
              code: "owner-required",
            },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Limit maintainer commands",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = context();

    const result = await authorizeCoreCommand({ command: command(), ctx, agentId: "main" });

    expect(result).toMatchObject({
      matched: true,
      allowed: false,
      commandKey: "restart",
      denial: { code: "owner-required" },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "command.invoke",
        phase: "final",
        commandName: "restart",
        owner: { kind: "core" },
        source: "native",
      }),
      {
        principal: {
          kind: "sender",
          provider: "discord",
          accountId: "default",
          senderId: "maintainer-1",
          senderIsOwner: false,
          isAuthorizedSender: true,
          roleIds: ["maintainers"],
        },
        agentId: "main",
        conversationId: "maintenance",
        parentConversationId: "maintenance",
        threadId: "thread-1",
        trigger: "command",
      },
      expect.any(AbortSignal),
    );
  });

  it("denies an ordinary Slack command scoped to a transport-only thread", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((_request, auth) =>
      auth.principal.kind === "sender" &&
      auth.principal.provider === "slack" &&
      auth.threadId === "1712345678.000100"
        ? { effect: "deny", code: "thread-denied" }
        : { effect: "pass" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "thread-access",
        description: "Deny commands in one Slack thread",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = context();
    ctx.Provider = "slack";
    ctx.NativeChannelId = "CMAINTENANCE";
    ctx.OriginatingTo = "channel:CMAINTENANCE";
    ctx.MessageThreadId = undefined;
    ctx.TransportThreadId = "1712345678.000100";

    const result = await authorizeCoreCommand({
      command: command({
        surface: "slack",
        channel: "slack",
        channelId: "slack",
        from: "slack:channel:CMAINTENANCE",
        to: "slack:channel:CMAINTENANCE",
      }),
      ctx,
      agentId: "main",
    });

    expect(result).toMatchObject({
      matched: true,
      allowed: false,
      commandKey: "restart",
      denial: { code: "thread-denied" },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "restart" }),
      expect.objectContaining({ threadId: "1712345678.000100" }),
      expect.any(AbortSignal),
    );
  });

  it("checks reset session mutation and final command phases independently", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(
      (request, authorizationContext) =>
        request.phase === "final" && authorizationContext.sessionId === "session-final"
          ? { effect: "deny" as const, code: "session-denied" }
          : { effect: "pass" as const },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Allow safe commands",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = context();

    await authorizeCoreCommand({
      command: command({ senderIsOwner: true }),
      ctx,
      agentId: "main",
      sessionId: "session-current",
      phase: "session-mutation",
    });
    const later = await authorizeCoreCommand({
      command: command({ senderIsOwner: true }),
      ctx,
      agentId: "main",
      sessionId: "session-final",
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([request]) => request.phase)).toEqual([
      "session-mutation",
      "final",
    ]);
    expect(later).toMatchObject({ allowed: false, denial: { code: "session-denied" } });
  });

  it("normalizes bigint command values without dropping valid siblings", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "command-values",
      source: "test",
      policy: {
        id: "command-values",
        description: "Inspect parsed command values",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);

    const result = await authorizeCoreCommandName({
      command: command(),
      ctx: context(),
      commandName: "restart",
      values: { mode: "safe", count: 2n },
    });

    expect(result).toEqual({ allowed: true });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { values: { mode: "safe", count: "2" } },
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["undefined", undefined],
    ["non-finite", Number.NaN],
  ])("fails closed for %s structured command values", async (_name, invalidValue) => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "command-values",
      source: "test",
      policy: {
        id: "command-values",
        description: "Inspect parsed command values",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);

    const result = await authorizeCoreCommandName({
      command: command(),
      ctx: context(),
      commandName: "restart",
      values: { mode: "delete", invalid: invalidValue },
    });

    expect(result).toMatchObject({
      allowed: false,
      denial: { code: "policy-input-invalid" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed for symbol-keyed structured command values", async () => {
    const handler = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "command-values",
      source: "test",
      policy: {
        id: "command-values",
        description: "Inspect parsed command values",
        handlers: { "command.invoke": handler },
      },
    });
    setActivePluginRegistry(registry);
    const values = { mode: "delete" } as Record<PropertyKey, unknown>;
    values[Symbol("hidden")] = "bypass";

    const result = await authorizeCoreCommandName({
      command: command(),
      ctx: context(),
      commandName: "restart",
      values: values as Record<string, unknown>,
    });

    expect(result).toMatchObject({
      allowed: false,
      denial: { code: "policy-input-invalid" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
