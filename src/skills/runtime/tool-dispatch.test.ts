// Skill tool dispatch tests cover policy-filtered tool surfaces.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import {
  createOperatorTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";

type CreateOpenClawToolsArg = {
  beforeToolCallHookContext?: {
    authorization?: unknown;
    skillCommand?: { skillFile?: string };
  };
  authorization?: unknown;
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
  agentAccountId?: string;
  agentChannel?: string;
  agentGroupId?: string;
  agentMemberRoleIds?: string[];
  agentThreadId?: string | number;
  agentTo?: string;
  currentChannelId?: string;
  nativeChannelId?: string;
  requesterSenderId?: string;
  runId?: string;
  senderIsOwner?: boolean;
  turnAuthority?: unknown;
};

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  return {
    createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("cron"),
      makeTool("exec"),
    ]),
  };
});

vi.mock("../../agents/openclaw-tools.runtime.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

import { resolveSkillDispatchTools } from "./tool-dispatch.js";

describe("resolveSkillDispatchTools", () => {
  it("passes final filtered tool surface to cron jobs", () => {
    const sessionKey = "agent:main:telegram:group:restricted-room";
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "telegram",
        accountId: "default",
        senderId: "user-1",
      }),
      agentId: "main",
      sessionKey,
      conversationId: "native-room-1",
      trigger: "channel",
    });
    const tools = resolveSkillDispatchTools({
      message: {
        surface: "telegram",
        senderId: "user-1",
        nativeChannelId: "native-room-1",
      },
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey,
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority,
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(args?.cronCreatorToolAllowlist).toEqual([{ name: "read" }, { name: "cron" }]);
    expect(args?.nativeChannelId).toBe("native-room-1");
  });

  it("carries command skill file identity into tool diagnostics", () => {
    const sessionKey = "agent:main:telegram:direct:user-1";
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "telegram",
        accountId: "default",
        senderId: "user-1",
      }),
      agentId: "main",
      sessionKey,
      conversationId: "user-1",
      trigger: "channel",
    });
    resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1", nativeChannelId: "user-1" },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey,
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority,
      skillCommand: {
        name: "daily-brief",
        skillFile: "/workspace/skills/daily-brief/SKILL.md",
        skillName: "Daily Brief",
        skillSource: "workspace",
        toolName: "read",
      },
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.beforeToolCallHookContext?.skillCommand?.skillFile).toBe(
      "/workspace/skills/daily-brief/SKILL.md",
    );
  });

  it("pins sender authorization to skill-dispatched tool calls", () => {
    const sessionKey = "agent:main:discord:channel:maintenance";
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["write", "maintainers"],
      }),
      agentId: "main",
      sessionKey,
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "maintenance",
      parentConversationId: "maintenance-parent",
      threadId: "thread-1",
      trigger: "channel",
    });
    resolveSkillDispatchTools({
      message: {
        surface: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        memberRoleIds: ["write", "maintainers"],
        nativeChannelId: "maintenance",
        messageThreadId: "thread-1",
        threadParentId: "maintenance-parent",
      },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionEntry: { sessionId: "session-1" } as never,
      sessionKey,
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-1",
      currentChannelId: "maintenance",
      turnAuthority,
      skillCommand: {
        name: "fix",
        skillName: "Fix",
        skillSource: "workspace",
        toolName: "exec",
      },
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.requesterSenderId).toBe("maintainer-1");
    expect(args?.senderIsOwner).toBe(false);
    expect(args?.beforeToolCallHookContext?.authorization).toBe(turnAuthority.authorization);
    expect(args?.authorization).toBe(turnAuthority.authorization);
    expect(args?.turnAuthority).toBe(turnAuthority);
    expect(args?.runId).toBe("run-1");
  });

  it("uses the admitted sender identity and route for sender and group policy", () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: "discord-account",
        senderId: "discord-maintainer",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      }),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      conversationId: "maintenance",
      parentConversationId: "maintenance-parent",
      threadId: "thread-1",
      trigger: "channel",
    });

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        provider: "webchat",
        accountId: "discord-account",
        senderId: "legacy-user",
        senderName: "Legacy Owner",
        senderUsername: "legacy-owner",
        senderE164: "+15555550100",
        senderIsOwner: true,
        isAuthorizedSender: false,
        memberRoleIds: ["legacy-role"],
        nativeChannelId: "maintenance",
        messageThreadId: "thread-1",
        threadParentId: "maintenance-parent",
      },
      cfg: {
        tools: {
          toolsBySender: {
            "channel:discord:discord-maintainer": { deny: ["exec"] },
            "channel:slack:discord-maintainer": { deny: ["read"] },
            "channel:webchat:discord-maintainer": { deny: ["read"] },
            "id:legacy-user": { deny: ["read"] },
          },
        },
        channels: {
          discord: {
            accounts: {
              "discord-account": {
                groups: {
                  maintenance: {
                    toolsBySender: {
                      "channel:discord:discord-maintainer": { deny: ["cron"] },
                      "channel:slack:discord-maintainer": { deny: ["read"] },
                    },
                  },
                },
              },
              "legacy-account": {
                groups: {
                  maintenance: { tools: { deny: ["read"] } },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      groupId: "forged-group",
      turnAuthority,
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(args?.agentChannel).toBe("discord");
    expect(args?.agentAccountId).toBe("discord-account");
    expect(args?.agentTo).toBe("maintenance");
    expect(args?.nativeChannelId).toBe("maintenance");
    expect(args?.currentChannelId).toBe("maintenance");
    expect(args?.agentGroupId).toBe("maintenance");
    expect(args?.agentThreadId).toBe("thread-1");
    expect(args?.requesterSenderId).toBe("discord-maintainer");
    expect(args?.senderIsOwner).toBe(false);
    expect(args?.agentMemberRoleIds).toEqual(["maintainers"]);
    expect(args?.authorization).toBe(turnAuthority.authorization);
  });

  it.each([
    {
      policyKey: "name:Ada Lovelace",
      aliasInput: { senderName: " Ada Lovelace " },
      forgedMessage: { senderName: "Forged User" },
      forgedPolicyKey: "name:Forged User",
    },
    {
      policyKey: "username:ada",
      aliasInput: { senderUsername: " @Ada " },
      forgedMessage: { senderUsername: "forged-user" },
      forgedPolicyKey: "username:forged-user",
    },
    {
      policyKey: "e164:+15550001111",
      aliasInput: { senderE164: " +15550001111 " },
      forgedMessage: { senderE164: "+15559999999" },
      forgedPolicyKey: "e164:+15559999999",
    },
  ] as const)(
    "uses issued $policyKey aliases for skill sender policy",
    ({ policyKey, aliasInput, forgedMessage, forgedPolicyKey }) => {
      const turnAuthority = createTurnAuthoritySnapshot({
        principal: createAuthorizationPrincipal({
          provider: "discord",
          accountId: "molty",
          senderId: "maintainer-1",
          ...aliasInput,
        }),
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        conversationId: "maintenance",
        trigger: "channel",
      });

      const tools = resolveSkillDispatchTools({
        message: {
          surface: "discord",
          accountId: "molty",
          senderId: "forged-sender",
          ...forgedMessage,
          nativeChannelId: "maintenance",
        },
        cfg: {
          tools: {
            toolsBySender: {
              [policyKey]: { deny: ["exec"] },
              [forgedPolicyKey]: { deny: ["read"] },
            },
          },
        } as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
        provider: "openai",
        model: "gpt-5.5",
        turnAuthority,
      });

      expect(tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
      expect(hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0]?.authorization).toBe(
        turnAuthority.authorization,
      );
    },
  );

  it.each([
    {
      binding: "missing agent id",
      authorityAgentId: undefined,
      authoritySessionKey: "agent:main:discord:channel:maintenance",
      authoritySessionId: undefined,
      executionSessionId: undefined,
    },
    {
      binding: "different agent id",
      authorityAgentId: "other",
      authoritySessionKey: "agent:main:discord:channel:maintenance",
      authoritySessionId: undefined,
      executionSessionId: undefined,
    },
    {
      binding: "missing session key",
      authorityAgentId: "main",
      authoritySessionKey: undefined,
      authoritySessionId: undefined,
      executionSessionId: undefined,
    },
    {
      binding: "different session key",
      authorityAgentId: "main",
      authoritySessionKey: "agent:main:discord:channel:other",
      authoritySessionId: undefined,
      executionSessionId: undefined,
    },
    {
      binding: "different session id",
      authorityAgentId: "main",
      authoritySessionKey: "agent:main:discord:channel:maintenance",
      authoritySessionId: "authority-session",
      executionSessionId: "execution-session",
    },
    {
      binding: "missing authority session id",
      authorityAgentId: "main",
      authoritySessionKey: "agent:main:discord:channel:maintenance",
      authoritySessionId: undefined,
      executionSessionId: "execution-session",
    },
    {
      binding: "missing execution session id",
      authorityAgentId: "main",
      authoritySessionKey: "agent:main:discord:channel:maintenance",
      authoritySessionId: "authority-session",
      executionSessionId: undefined,
    },
  ] as const)(
    "rejects issued authority with $binding",
    ({ authorityAgentId, authoritySessionKey, authoritySessionId, executionSessionId }) => {
      const turnAuthority = createTurnAuthoritySnapshot({
        principal: createAuthorizationPrincipal({
          provider: "discord",
          accountId: "molty",
          senderId: "maintainer-1",
        }),
        agentId: authorityAgentId,
        sessionKey: authoritySessionKey,
        sessionId: authoritySessionId,
        conversationId: "maintenance",
        trigger: "channel",
      });
      const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

      const tools = resolveSkillDispatchTools({
        message: {
          surface: "discord",
          accountId: "molty",
          nativeChannelId: "maintenance",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionEntry: executionSessionId ? ({ sessionId: executionSessionId } as never) : undefined,
        sessionKey: "agent:main:discord:channel:maintenance",
        workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
        provider: "openai",
        model: "gpt-5.5",
        turnAuthority,
      });

      expect(tools).toEqual([]);
      expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
    },
  );

  it.each([
    {
      binding: "different run id",
      authorityRunId: "authority-run",
      executionRunId: "execution-run",
    },
    {
      binding: "missing authority run id",
      authorityRunId: undefined,
      executionRunId: "execution-run",
    },
    {
      binding: "missing execution run id",
      authorityRunId: "authority-run",
      executionRunId: undefined,
    },
  ] as const)("rejects issued authority with $binding", ({ authorityRunId, executionRunId }) => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
      }),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      runId: authorityRunId,
      conversationId: "maintenance",
      trigger: "channel",
    });
    const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
      },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      runId: executionRunId,
      turnAuthority,
    });

    expect(tools).toEqual([]);
    expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
  });

  it.each([
    {
      binding: "provider mismatch",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "slack",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "account mismatch",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "other",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "missing admitted account",
      authority: {
        accountId: undefined,
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "conversation mismatch",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "other",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "missing admitted conversation",
      authority: {
        accountId: "molty",
        conversationId: undefined,
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "missing route conversation",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: undefined,
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
    {
      binding: "parent conversation mismatch",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: "parent-1",
        threadId: undefined,
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: "parent-2",
        messageThreadId: undefined,
      },
    },
    {
      binding: "thread mismatch",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: "thread-1",
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: "thread-2",
      },
    },
    {
      binding: "missing route thread",
      authority: {
        accountId: "molty",
        conversationId: "maintenance",
        parentConversationId: undefined,
        threadId: "thread-1",
      },
      message: {
        surface: "discord",
        accountId: "molty",
        nativeChannelId: "maintenance",
        threadParentId: undefined,
        messageThreadId: undefined,
      },
    },
  ] as const)("rejects sender authority with $binding", ({ authority, message }) => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: authority.accountId,
        senderId: "maintainer-1",
      }),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      conversationId: authority.conversationId,
      parentConversationId: authority.parentConversationId,
      threadId: authority.threadId,
      trigger: "channel",
    });
    const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

    const tools = resolveSkillDispatchTools({
      message,
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority,
    });

    expect(tools).toEqual([]);
    expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
  });

  it("uses operator authority instead of conflicting legacy sender fields", () => {
    const turnAuthority = createOperatorTurnAuthoritySnapshot({
      scopes: ["operator.write"],
      pairedClientId: "control-ui",
      connectionId: "connection-1",
      isOwner: false,
      agentId: "main",
      sessionKey: "agent:main:main",
      conversationId: "maintenance",
      trigger: "gateway",
    });

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        accountId: "molty",
        senderId: "forged-sender",
        senderName: "Forged Owner",
        senderIsOwner: true,
        isAuthorizedSender: false,
        memberRoleIds: ["forged-role"],
        nativeChannelId: "maintenance",
      },
      cfg: {
        tools: {
          toolsBySender: {
            "id:forged-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority,
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(tools.map((tool) => tool.name)).toEqual(["read", "cron", "exec"]);
    expect(args?.requesterSenderId).toBeUndefined();
    expect(args?.senderIsOwner).toBe(false);
    expect(args?.agentMemberRoleIds).toBeUndefined();
    expect(args?.authorization).toBe(turnAuthority.authorization);
    expect(args?.beforeToolCallHookContext?.authorization).toBe(turnAuthority.authorization);
    expect(args?.turnAuthority).toBe(turnAuthority);
  });

  it("fails closed instead of authenticating legacy message identity without authority", () => {
    const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        accountId: "molty",
        senderId: "legacy-owner",
        senderIsOwner: true,
        isAuthorizedSender: true,
        nativeChannelId: "maintenance",
      },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(tools).toEqual([]);
    expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
  });

  it("fails closed for an issued unknown principal", () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({ provider: "discord", accountId: "molty" }),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      conversationId: "maintenance",
      trigger: "channel",
    });
    const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        accountId: "molty",
        senderId: "legacy-owner",
        senderIsOwner: true,
        nativeChannelId: "maintenance",
      },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority,
    });

    expect(tools).toEqual([]);
    expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
  });

  it("does not fall back to legacy identity when a supplied snapshot is unissued", () => {
    const callCount = hoisted.createOpenClawToolsMock.mock.calls.length;

    const tools = resolveSkillDispatchTools({
      message: {
        surface: "discord",
        senderId: "legacy-owner",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      cfg: {} as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
      turnAuthority: {
        authorization: {
          principal: { kind: "sender", senderId: "legacy-owner", senderIsOwner: true },
        },
      } as never,
    });

    expect(tools).toEqual([]);
    expect(hoisted.createOpenClawToolsMock).toHaveBeenCalledTimes(callCount);
  });
});
