import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { routeReplyDirectivesForTest } from "./get-reply-directives-routing.test-support.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runInlineFixture } from "./get-reply-inline-actions.shard-test-support.js";
import {
  createHandleInlineActionsInput,
  createInlineToolDispatchFixture,
  createOpenClawToolsMock,
  createTypingController,
  mockCallArgs,
  runTestInlineActions as runBaseInlineActions,
  type HandleInlineActionsInput,
} from "./get-reply-inline-actions.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { stripInlineStatus } from "./reply-inline.js";
import { buildTestCtx } from "./test-ctx.js";

function commandCtx(body: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildTestCtx({ Body: body, CommandBody: body, ...overrides });
}

type InlineInput = Parameters<typeof runBaseInlineActions>[0];
function runTestInlineActions(
  params: Pick<InlineInput, "ctx"> & Partial<Omit<InlineInput, "ctx">>,
) {
  return runBaseInlineActions({
    cleanedBody: params.ctx.commandText,
    typing: createTypingController(),
    ...params,
    command: { isAuthorizedSender: true, ...params.command },
    overrides: { allowTextCommands: true, ...params.overrides },
  });
}

const runTool = (
  fixture: Parameters<typeof runInlineFixture>[0],
  overrides?: Parameters<typeof runInlineFixture>[1],
) => runInlineFixture(fixture, overrides, { senderId: "sender-1", abortKey: "sender-1" });

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-inline-acp-policy-");

const {
  buildStatusReplyMock,
  getChannelPluginMock,
  handleCommandsMock,
  prepareSkillCommandsForWorkspaceMock,
} = vi.hoisted(() => ({
  buildStatusReplyMock: vi.fn<typeof import("./commands.js").buildStatusReply>(),
  getChannelPluginMock: vi.fn(),
  handleCommandsMock: vi.fn<typeof import("./commands.js").handleCommands>(),
  prepareSkillCommandsForWorkspaceMock: vi.fn(),
}));

vi.mock("./commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands.js")>()),
  handleCommands: handleCommandsMock,
  buildStatusReply: buildStatusReplyMock,
}));

vi.mock("../../skills/discovery/chat-commands.runtime.js", () => ({
  prepareSkillCommandsForWorkspace: prepareSkillCommandsForWorkspaceMock,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  getLoadedChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  listChannelPlugins: () => [],
  normalizeChannelId: (value?: string) => value?.trim().toLowerCase() || null,
}));

const renderedSlackMentionPattern = "<@BOT> \\(Bek \\(Ops\\)\\)";

// Model the plugin-owned exact substitution fact at the loaded-plugin seam.
vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>()),
  getLoadedChannelPluginById: (id: string) =>
    id === "slack"
      ? {
          id: "slack",
          config: {},
          mentions: {
            stripPatterns: () => [renderedSlackMentionPattern, "<@[^>\\s]+>"],
          },
        }
      : undefined,
}));

function expectReply(result: Awaited<ReturnType<typeof runBaseInlineActions>>, text: string) {
  expect(result).toEqual({ kind: "reply", reply: { text } });
}

async function routeSender(ctx: ReturnType<typeof buildTestCtx>, isGroup: boolean) {
  const onBlockReply = vi.fn(async () => {});
  handleCommandsMock.mockImplementation(async ({ command }) => ({
    shouldContinue: true,
    ...(command.commandBodyNormalized === "/help" ? { reply: { text: "Sender help output" } } : {}),
  }));
  const routing = await routeReplyDirectivesForTest({ ...ctx, WasMentioned: isGroup }, { isGroup });
  const result = await runTestInlineActions({
    ctx,
    cleanedBody: routing.cleanedBody,
    command: { rawBodyNormalized: ctx.commandText, commandBodyNormalized: ctx.commandText },
    overrides: {
      cfg: { commands: { text: true } },
      directives: routing.directives,
      inlineCommand: routing.inlineCommand,
      opts: { onBlockReply },
    },
  });
  return { result, routing, onBlockReply };
}

function toolFixture<T = { content: string }>(
  name: "spawn_subagent" | "set_profile" | "send_status" | "list_sessions",
  execute?: () => Promise<T>,
  extra: Partial<
    Pick<
      Parameters<typeof createInlineToolDispatchFixture>[0],
      "nativeChannelId" | "skill" | "toolName"
    >
  > = {},
) {
  const skill = {
    name,
    skillName: name === "set_profile" ? "matrix-profile" : name.replaceAll("_", "-"),
    description: name,
  };
  const [toolName, args] = (
    {
      spawn_subagent: ["sessions_spawn", "investigate"],
      set_profile: ["message", "display name"],
      list_sessions: ["sessions_list", "now"],
      send_status: ["message", "hello"],
    } as const
  )[name];
  return createInlineToolDispatchFixture<T | { content: string }>({
    body: `/${name} ${args}`,
    toolName,
    execute: execute ?? (async () => ({ content: "sent" })),
    skill,
    sourceFilePath: `/tmp/plugin/commands/${name.replaceAll("_", "-")}.md`,
    ...extra,
  });
}

function officeHoursSkillCommands(inline = false): SkillCommandSpec[] {
  return [
    {
      name: "office_hours",
      skillName: "office-hours",
      description: "Office hours",
      ...(inline
        ? { modelVisible: true, skillFile: "/tmp/skills/office-hours/SKILL.md" }
        : {
            promptTemplate: "Act as an engineering advisor.\n\nFocus on:\n$ARGUMENTS",
            sourceFilePath: "/tmp/plugin/commands/office-hours.md",
          }),
    },
  ];
}

function expandedOfficeHoursRequest(body: string): string {
  return `Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:\n- office-hours\n\nUser request:\n${body}`;
}

describe("handleInlineActions", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset().mockResolvedValue({ shouldContinue: true, reply: undefined });
    prepareSkillCommandsForWorkspaceMock.mockReset().mockReturnValue([]);
    getChannelPluginMock.mockReset();
    createOpenClawToolsMock.mockReset();
    buildStatusReplyMock.mockReset().mockResolvedValue({ text: "status" });
    createOpenClawToolsMock.mockReturnValue([]);
    getChannelPluginMock.mockImplementation((channelId?: string) =>
      channelId === "whatsapp"
        ? { commands: { skipWhenConfigEmpty: true } }
        : channelId === "discord"
          ? { mentions: { stripPatterns: () => ["<@!?\\d+>"] } }
          : undefined,
    );
  });

  it("notifies session metadata changes before continuing after a command", async () => {
    const ctx = commandCtx("/goal build the thing");
    const onSessionMetadataChanges = vi.fn();
    handleCommandsMock.mockImplementationOnce(async (params) => {
      markCommandSessionMetadataChanged(params);
      return { shouldContinue: true };
    });

    const result = await runTestInlineActions({
      ctx,
      overrides: {
        opts: {
          onSessionMetadataChanges,
        } as unknown as HandleInlineActionsInput["opts"],
      },
    });

    expect(result.kind).toBe("continue");
    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey: "s:main", agentId: "main", reason: "command-metadata" },
    ]);
  });

  it.each(["steer", "followup"] as const)(
    "propagates an explicit %s queue override into the prepared-turn result",
    async (mode) => {
      const ctx = commandCtx(`/${mode} use the monochrome version`);
      handleCommandsMock.mockImplementationOnce(async (params) => {
        params.command.rawBodyNormalized = "use the monochrome version";
        params.command.commandBodyNormalized = "use the monochrome version";
        params.ctx.agentText = "use the monochrome version";
        return { shouldContinue: true, queueModeOverride: mode };
      });

      const result = await runTestInlineActions({
        ctx,
        overrides: {
          cfg: { commands: { text: true } },
        },
      });

      expect(result).toMatchObject({
        kind: "continue",
        queueModeOverride: mode,
      });
      expect(ctx.agentText).toBe("use the monochrome version");
    },
  );

  it("prefers the target session entry when routing inline status through the shared status builder", async () => {
    const ctx = commandCtx("/status", {
      ParentSessionKey: "ctx-parent",
    });

    const result = await runTestInlineActions({
      ctx,
      cleanedBody: stripInlineStatus("/status").cleaned,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/status",
        commandBodyNormalized: "/status",
      },
      overrides: {
        inlineStatusRequested: true,
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          parentSessionKey: "wrapper-parent",
        } as SessionEntry,
        sessionStore: {
          "s:main": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            parentSessionKey: "target-parent",
          } as SessionEntry,
        },
      },
    });

    expect(result).toEqual({ kind: "reply", reply: undefined });
    const statusArgs = buildStatusReplyMock.mock.calls[0]?.[0];
    expect(statusArgs).toMatchObject({
      sessionEntry: { sessionId: "target-session", parentSessionKey: "target-parent" },
      parentSessionKey: "target-parent",
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("continues into the agent when mention-wrapped inline status leaves real text", async () => {
    const ctx = commandCtx("<@123> /status what's next?", {
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      WasMentioned: true,
    });

    const result = await runTestInlineActions({
      ctx,
      cleanedBody: "<@123> what's next?",
      command: {
        surface: "discord",
        channel: "discord",
        channelId: "discord",
        isAuthorizedSender: true,
        rawBodyNormalized: "<@123> /status what's next?",
        commandBodyNormalized: "<@123> /status what's next?",
      },
      overrides: {
        inlineStatusRequested: true,
        isGroup: true,
      },
    });

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("<@123> what's next?"),
      abortedLastRun: false,
    });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });

  it.each(["stale queued message", "empty channel config"])(
    "skips /skill before loading or dispatching: %s",
    async (reason) => {
      const typing = createTypingController();
      const { toolExecute, skillCommands } = toolFixture(
        "send_status",
        async () => ({ text: "sent" }),
        {
          toolName: "send_status",
        },
      );
      prepareSkillCommandsForWorkspaceMock.mockReturnValue(skillCommands);
      const stale = reason === "stale queued message";
      const sessionEntry: SessionEntry = {
        sessionId: "session-skill",
        updatedAt: Date.now(),
        abortCutoffMessageSid: "42",
        abortedLastRun: true,
      };
      const result = await runTestInlineActions({
        typing,
        ctx: commandCtx(
          "/skill send_status now",
          stale ? { MessageSid: "41" } : { From: "whatsapp:+999", To: "whatsapp:+123" },
        ),
        command: stale ? {} : { to: "whatsapp:+123" },
        overrides: {
          cfg: stale ? { commands: { text: true } } : {},
          skillCommands: [],
          ...(stale ? { sessionEntry, sessionStore: { "s:main": sessionEntry } } : {}),
        },
      });
      expect(result).toEqual({ kind: "reply", reply: undefined });
      expect(typing.cleanup).toHaveBeenCalledOnce();
      expect(handleCommandsMock).not.toHaveBeenCalled();
      expect(prepareSkillCommandsForWorkspaceMock).not.toHaveBeenCalled();
      expect(createOpenClawToolsMock).not.toHaveBeenCalled();
      expect(toolExecute).not.toHaveBeenCalled();
    },
  );

  it("clears /stop cutoff when a newer message arrives", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "ok" } });
    const ctx = commandCtx("new message", {
      MessageSid: "43",
    });

    const result = await runTestInlineActions({
      ctx,
      command: { isAuthorizedSender: false },
      overrides: {
        allowTextCommands: false,
        sessionEntry,
        sessionStore,
      },
    });

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("new message"),
      abortedLastRun: false,
    });
    expect(sessionStore["s:main"].abortCutoffMessageSid).toBeUndefined();
    expect(sessionStore["s:main"].abortCutoffTimestamp).toBeUndefined();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("keeps literal $ patterns in bundle command arguments", async () => {
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = commandCtx("/office_hours price $$ and $& here");
    const skillCommands = officeHoursSkillCommands();

    const result = await runTestInlineActions({
      ctx,
      overrides: {
        cfg: { commands: { text: true } },
        skillCommands,
      },
    });

    expectReply(result, "done");
    expect(ctx.Body).toBe("Act as an engineering advisor.\n\nFocus on:\nprice $$ and $& here");
    const commandArgs = handleCommandsMock.mock.calls[0]?.[0];
    expect(commandArgs?.ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nprice $$ and $& here",
    );
  });

  it("keeps unauthorized explicit skill references as plain text", async () => {
    const body = "Please use $office_hours to build me a deployment plan";
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      Provider: "webchat",
      Surface: "webchat",
    });

    const result = await runTestInlineActions({
      ctx,
      cleanedBody: body,
      command: {
        isAuthorizedSender: false,
      },
      overrides: {
        cfg: { commands: { text: true } },
        skillCommands: officeHoursSkillCommands(true),
      },
    });

    expect(result.kind).toBe("continue");
    expect(ctx.Body).toBe(body);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("preserves suppressed inline command text under a wildcard command allowlist", async () => {
    const body = "Explain /help please";
    const cfg = { commands: { allowFrom: { "*": ["*"] } } };
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandInterpretationSuppressed: true,
    });
    const command = buildCommandContext({
      ctx,
      cfg,
      isGroup: false,
      triggerBodyNormalized: ctx.commandText,
      commandAuthorized: ctx.CommandAuthorized,
    });

    const result = await runTestInlineActions({
      ctx,
      typing: createTypingController(),
      cleanedBody: ctx.agentText,
      command,
      overrides: { cfg, allowTextCommands: true },
    });

    expect(result.kind).toBe("continue");
    expect(ctx.agentText).toBe(body);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("loads workspace skills when /skill gets an empty preloaded command list", async () => {
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = commandCtx("/skill office_hours build me a deployment plan");
    const skillCommands = officeHoursSkillCommands();
    prepareSkillCommandsForWorkspaceMock.mockReturnValue(skillCommands);

    const result = await runTestInlineActions({
      ctx,
      overrides: {
        cfg: { commands: { text: true } },
        skillCommands: [],
      },
    });

    expectReply(result, "done");
    expect(prepareSkillCommandsForWorkspaceMock).toHaveBeenCalledOnce();
    expect(ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
    const commandArgs = handleCommandsMock.mock.calls[0]?.[0];
    expect(commandArgs?.skillCommands).toEqual(skillCommands);
  });

  it("returns a visible error for an allowlist-hidden addressed skill", async () => {
    const channelBody = "/office_hours@openclaw review this";
    const normalizedBody = "/office_hours review this";
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: channelBody,
      CommandBody: normalizedBody,
      BotUsername: "openclaw",
    });
    prepareSkillCommandsForWorkspaceMock.mockImplementation(
      (params: { includeAllowlistHidden?: boolean }) =>
        params.includeAllowlistHidden
          ? [
              {
                name: "office_hours",
                skillName: "office-hours",
                description: "Engineering office hours",
                skillFile: "/tmp/skills/office-hours/SKILL.md",
              },
            ]
          : [],
    );

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: channelBody,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: normalizedBody,
        commandBodyNormalized: normalizedBody,
      },
      overrides: {
        cfg: { commands: { text: true } },
        skillCommands: [],
        skillFilter: ["another-skill"],
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: 'Skill "office-hours" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
      },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it("passes requesterAgentIdOverride into inline tool runtimes", async () => {
    const { typing, toolExecute, ctx, skillCommands } = toolFixture("spawn_subagent", async () => ({
      text: "spawned",
    }));

    const result = await runTool(
      { ctx, typing, skillCommands },
      {
        agentId: "named-worker",
      },
    );

    expectReply(result, "✅ Done.");
    expect(createOpenClawToolsMock.mock.calls[0]?.[0]).toMatchObject({
      requesterAgentIdOverride: "named-worker",
    });
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });

  it("passes sender identity into inline tool runtimes", async () => {
    const { typing, toolExecute, ctx, skillCommands } = toolFixture(
      "set_profile",
      async () => ({ text: "updated" }),
      {
        skill: {
          name: "set_profile",
          skillName: "matrix-profile",
          description: "Set Matrix profile",
          skillSource: "workspace",
        },
        nativeChannelId: "oc_native_chat",
      },
    );

    const result = await runTool({ ctx, typing, skillCommands });

    expectReply(result, "✅ Done.");
    const toolsArgs = createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(toolsArgs).toMatchObject({
      senderIsOwner: true,
      nativeChannelId: "oc_native_chat",
      beforeToolCallHookContext: {
        cwd: "/tmp",
        workspaceDir: "/tmp",
        skillCommand: {
          commandName: "set_profile",
          skillName: "matrix-profile",
          skillSource: "workspace",
          toolName: "message",
        },
      },
    });
    const toolCall = mockCallArgs(toolExecute, "toolExecute");
    expect(toolCall).toEqual([
      expect.stringMatching(/^cmd_/),
      {
        command: "display name",
        commandName: "set_profile",
        skillName: "matrix-profile",
      },
      undefined,
    ]);
  });

  it("honors construction-time before-tool-call blocks for inline tool dispatch", async () => {
    const abortController = new AbortController();
    const { typing, toolExecute, ctx, skillCommands } = toolFixture("set_profile", async () => ({
      content: [{ type: "text", text: "denied by policy" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "denied by policy",
      },
    }));

    const result = await runTool(
      { ctx, typing, skillCommands },
      {
        cfg: {
          commands: { text: true },
          tools: {
            loopDetection: {
              enabled: true,
            },
          },
        },
        agentId: "main",
        opts: { abortSignal: abortController.signal },
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: 0,
        },
        sessionStore: {
          "s:main": {
            sessionId: "target-session",
            updatedAt: 0,
          },
        },
      },
    );

    expectReply(result, "❌ Tool call blocked: denied by policy");
    const toolsArgs = createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(toolsArgs).toMatchObject({ sessionId: "target-session", currentChannelId: "whatsapp" });
    const blockedToolCall = mockCallArgs(toolExecute, "toolExecute");
    expect(blockedToolCall).toEqual([
      expect.stringMatching(/^cmd_/),
      {
        command: "display name",
        commandName: "set_profile",
        skillName: "matrix-profile",
      },
      abortController.signal,
    ]);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each<{
    name: string;
    tools: NonNullable<HandleInlineActionsInput["cfg"]["tools"]>;
    extraTool?: boolean;
  }>([
    { name: "global deny", tools: { deny: ["message"] } },
    { name: "allowlist exclusion", tools: { allow: ["sessions_list"] }, extraTool: true },
    { name: "sender deny", tools: { toolsBySender: { "id:sender-1": { deny: ["message"] } } } },
  ])("blocks inline dispatch under $name", async ({ tools, extraTool }) => {
    const fixture = toolFixture("send_status", async () => ({
      content: "sent",
    }));
    const sessionsExecute = vi.fn(async () => ({ content: "listed" }));
    if (extraTool) {
      createOpenClawToolsMock.mockReturnValue([
        { name: "message", execute: fixture.toolExecute },
        { name: "sessions_list", execute: sessionsExecute },
      ]);
    }
    expectReply(
      await runTool(fixture, { cfg: { commands: { text: true }, tools } }),
      "❌ Tool not available: message",
    );
    expect(fixture.toolExecute).not.toHaveBeenCalled();
    if (extraTool) {
      expect(sessionsExecute).not.toHaveBeenCalled();
    }
  });

  it("applies subagent policy to ACP envelope inline dispatch sessions", async () => {
    const storeTemplate = path.join(sessionDirs.make(), "sessions-{agentId}.json");
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: "agent:main:acp:leaf",
        storePath: storeTemplate.replaceAll("{agentId}", "main"),
      },
      {
        sessionId: "session-acp-leaf",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:subagent:parent",
        spawnDepth: 2,
        subagentRole: "leaf",
        subagentControlScope: "none",
      },
    );

    const { typing, toolExecute, ctx, skillCommands } = toolFixture("spawn_subagent", async () => ({
      content: "spawned",
    }));

    const result = await runTool(
      { ctx, typing, skillCommands },
      {
        cfg: {
          commands: { text: true },
          session: { store: storeTemplate },
          agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
        },
        sessionKey: "agent:main:acp:leaf",
      },
    );

    expectReply(result, "❌ Tool not available: sessions_spawn");
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("passes sandboxed runtime state into inline tool construction", async () => {
    const { typing, toolExecute, ctx, skillCommands } = toolFixture("list_sessions", async () => ({
      content: "listed",
    }));

    const result = await runTool(
      { ctx, typing, skillCommands },
      {
        cfg: {
          commands: { text: true },
          agents: { defaults: { sandbox: { mode: "all" } } },
        },
        sessionKey: "agent:main:thread",
      },
    );

    expectReply(result, "listed");
    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxed: true,
      }),
    );
    expect(toolExecute).toHaveBeenCalled();
  });

  it("marks command-handler terminal replies for direct delivery (#87107)", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compacted (76k → 934 tokens)" },
    });

    const ctx = commandCtx("/compact");

    const result = await runTestInlineActions({
      ctx,
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
      },
      overrides: {
        cfg: { commands: { text: true } },
      },
    });

    expect(result.kind).toBe("reply");
    if (result.kind !== "reply") {
      throw new Error("expected reply");
    }
    expect(result.reply).toEqual({ text: "⚙️ Compacted (76k → 934 tokens)" });
    // Source suppression keeps the existing message-tool contract; command
    // provenance permits final delivery beside an active session operation.
    expect(getReplyPayloadMetadata(result.reply as object)).toMatchObject({
      commandReply: true,
      deliverDespiteSourceReplySuppression: true,
    });
  });
  it.each([
    {
      name: "forward-only help",
      commandText: "",
      agentText: "[Forwarded message]\n/help marker",
    },
    {
      name: "caption with forwarded help",
      commandText: "Please summarize",
      agentText: "Please summarize\n[Forwarded message]\n/help marker",
    },
  ])("routes $name from the sender projection", async ({ commandText, agentText }) => {
    const ctx = buildTestCtx({
      CommandBody: commandText,
      RawBody: commandText,
      BodyForAgent: agentText,
      CommandAuthorized: true,
    });
    const { result, routing, onBlockReply } = await routeSender(ctx, false);
    expect(result.kind).toBe("continue");
    expect(routing.cleanedBody).toBe(agentText);
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "channel mention",
      rawText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandSourceText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please continue",
    },

    {
      name: "multiline sender before attachment context",
      rawText: "<@BOT> (Bek (Ops)) Please /help\ncontinue\n[slack attachment unavailable]",
      commandSourceText: "<@BOT> (Bek (Ops)) Please /help\ncontinue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please\ncontinue\n[slack attachment unavailable]",
    },
  ])("routes a Slack inline shortcut once after $name rendering", async (params) => {
    const { rawText, commandSourceText, commandText, expected } = params;
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
      From: "slack:U1",
      To: "slack:C1",
      CommandBody: commandText,
      RawBody: rawText,
      BodyForAgent: rawText,
      CommandAuthorized: true,
      ChannelContext: { chat: { commandSourceText } },
    });
    const { result, routing, onBlockReply } = await routeSender(ctx, true);
    expect(routing.inlineCommand).toBe("/help");
    expect(result.kind).toBe("continue");
    expect(routing.cleanedBody).toBe(expected);
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
      text: "Sender help output",
      isStatusNotice: true,
    });
    // The ordinary command pass still sees the full sender body; only one call selects /help.
    expect(
      handleCommandsMock.mock.calls
        .map(([commandParams]) => commandParams.command.commandBodyNormalized)
        .filter((body) => body === "/help"),
    ).toEqual(["/help"]);
  });
  it("keeps recorded shortcuts inside a skill prompt template", async () => {
    const body = "/skill office_hours compare /help and /commands";
    const ctx = buildTestCtx({ Body: body, RawBody: body, CommandBody: body });
    const onBlockReply = vi.fn(async () => {});
    handleCommandsMock.mockImplementation(async ({ command }) => ({
      shouldContinue: true,
      ...(command.commandBodyNormalized === "/help" ? { reply: { text: "Help output" } } : {}),
    }));
    const result = await runTestInlineActions({
      ctx,
      typing: createTypingController(),
      cleanedBody: body,
      overrides: {
        cfg: { commands: { text: true } },
        skillCommands: officeHoursSkillCommands(),
        inlineCommand: "/help",
        opts: { onBlockReply },
      },
    });
    const expected = "Act as an engineering advisor.\n\nFocus on:\ncompare /help and /commands";
    expect(result.kind).toBe("continue");
    expect(ctx.Body).toBe(expected);
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(
      handleCommandsMock.mock.calls.map(([params]) => params.command.commandBodyNormalized),
    ).toEqual([body]);
  });
});

describe("sender command dispatch ownership", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
    prepareSkillCommandsForWorkspaceMock
      .mockReset()
      .mockReturnValue(officeHoursSkillCommands(true));
    getChannelPluginMock.mockReset();
    createOpenClawToolsMock.mockReset();
    buildStatusReplyMock.mockReset();
  });

  it.each([
    {
      name: "explicit skill reference",
      shape: "skill",
      forwarded: false,
      commandName: "/help",
      commandText: "$office_hours compare /help literally",
    },
    {
      name: "uppercase alias standalone",
      shape: "standalone",
      forwarded: true,
      commandName: "/whoami",
      commandText: "/ID",
      normalized: "/whoami",
    },
    {
      name: "targeted standalone control",
      shape: "standalone",
      forwarded: true,
      commandName: "/help",
      commandText: "/help@OpenClaw:",
      normalized: "/help",
      botUsername: "OpenClaw",
    },
    {
      name: "leading arguments control",
      shape: "inline",
      forwarded: true,
      commandName: "/help",
      commandText: "/help Please explain",
      expectedPrompt: "Please explain",
    },
  ])(
    "$name $commandName",
    async ({
      shape,
      forwarded,
      commandName,
      commandText,
      normalized = commandText,
      botUsername,
      expectedPrompt,
    }) => {
      const suffix = forwarded ? "\n[Forwarded message]\nA separate quoted request." : "";
      const agentText = commandText + suffix;
      const ctx = buildTestCtx({
        Body: agentText,
        BodyForAgent: agentText,
        RawBody: commandText,
        CommandBody: commandText,
        CommandAuthorized: true,
        Provider: "discord",
        Surface: "discord",
        From: "discord:123456789012345678",
        To: "channel:223456789012345678",
        SenderId: "123456789012345678",
        BotUsername: botUsername,
      });
      const sessionCtx = { ...ctx, BodyStripped: ctx.agentText };
      const typing = createTypingController();
      const cfg = withFastReplyConfig({
        commands: { text: true },
        agents: { defaults: { thinkingDefault: "off" as const, reasoningDefault: "off" as const } },
      });
      const sessionEntry = { sessionId: "sender-command-session", updatedAt: 1 };
      const onBlockReply = vi.fn(async (_reply: { text?: string }) => {});
      const commandReply = "Output for " + commandName;
      handleCommandsMock.mockImplementation(async ({ command }) =>
        ["/help", "/commands", "/whoami"].includes(command.commandBodyNormalized)
          ? { shouldContinue: false, reply: { text: commandReply } }
          : { shouldContinue: true },
      );

      const directiveResult = await resolveReplyDirectives({
        ctx,
        cfg,
        agentId: "main",
        agentDir: "/tmp/main-agent",
        workspaceDir: "/tmp",
        agentCfg: cfg.agents.defaults,
        sessionCtx,
        sessionEntry,
        sessionStore: {},
        sessionKey: "agent:main:discord:direct:123456789012345678",
        sessionScope: "per-sender",
        conversation: prepareReplyConversation({ ctx: sessionCtx, sessionEntry }),
        isGroup: false,
        triggerBodyNormalized: ctx.commandText,
        resetTriggered: false,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        provider: "openai",
        model: "gpt-4o-mini",
        hasResolvedHeartbeatModelOverride: false,
        typing,
      });
      expect(directiveResult.kind).toBe("continue");
      if (directiveResult.kind !== "continue") {
        throw new Error("expected command routing continuation");
      }
      const routed = directiveResult.result;
      expect(routed.command).toMatchObject({
        isAuthorizedSender: true,
        commandBodyNormalized: normalized,
      });
      const input = createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: routed.cleanedBody,
        command: routed.command,
        overrides: {
          cfg,
          sessionEntry,
          sessionKey: "agent:main:discord:direct:123456789012345678",
          allowTextCommands: routed.allowTextCommands,
          inlineStatusRequested: routed.inlineStatusRequested,
          inlineCommand: routed.inlineCommand,
          skillCommands: routed.skillCommands,
          directives: routed.directives,
          opts: { onBlockReply },
        },
      });
      input.sessionCtx = sessionCtx;
      const result = await handleInlineActions(input);
      const dispatched = handleCommandsMock.mock.calls.map(
        ([params]) => params.command.commandBodyNormalized,
      );

      if (shape === "skill") {
        const expected = expandedOfficeHoursRequest(commandText);
        expect(result.kind).toBe("continue");
        expect(sessionCtx.agentText).toBe(expected);
        expect(dispatched).toEqual([]);
        expect(onBlockReply).not.toHaveBeenCalled();
      } else if (shape === "standalone") {
        expect(dispatched.filter((body) => body === commandName)).toHaveLength(1);
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(result).toMatchObject({ kind: "reply", reply: { text: commandReply } });
      } else {
        expect(dispatched.filter((body) => body === commandName)).toHaveLength(1);
        expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
          text: commandReply,
          isStatusNotice: true,
        });
        expect(result.kind).toBe("continue");
        expect(sessionCtx.agentText).toBe(expectedPrompt + suffix);
      }
    },
  );
});
