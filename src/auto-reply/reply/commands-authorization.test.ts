import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationPolicyHandler } from "../../plugins/authorization-policy.types.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { MsgContext } from "../templating.js";
import {
  authorizeCoreCommand,
  authorizeCoreCommandName,
  shouldAuthorizeCoreCommandTurn,
} from "./commands-authorization.js";
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
