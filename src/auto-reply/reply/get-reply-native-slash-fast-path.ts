import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  resolveThinkingDefaultWithRuntimeCatalog,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  isNativeCommandTurn,
  isTextSlashCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import { normalizeCommandBody, shouldHandleTextCommands } from "../commands-registry.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeThinkLevel, type ThinkLevel } from "../thinking.js";
import { buildCommandContext } from "./commands-context.js";
import { parseInlineDirectives, type InlineDirectives } from "./directive-handling.parse.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { stripStructuralPrefixes } from "./mentions.js";
import type { createTypingController } from "./typing.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
type SkillCommandsRuntime = typeof import("../skill-commands.runtime.js");

const commandsRuntimeLoader = createLazyImportLoader(() => import("./commands.runtime.js"));
const skillCommandsRuntimeLoader = createLazyImportLoader<SkillCommandsRuntime>(
  () => import("../skill-commands.runtime.js"),
);
const statusCommandRuntimeLoader = createLazyImportLoader(() => import("./commands-status.js"));

type TextSlashFastPathIntent =
  | { kind: "status"; commandBodyNormalized: string }
  | { kind: "directive"; commandBodyNormalized: string }
  | { kind: "command"; commandBodyNormalized: string };

const TEXT_FAST_PATH_DIRECTIVE_COMMANDS = new Set(["think", "verbose", "fast", "reasoning"]);
const TEXT_FAST_PATH_COMMAND_HANDLERS = new Set(["activation", "send", "usage", "whoami"]);

function loadCommandsRuntime() {
  return commandsRuntimeLoader.load();
}

function loadSkillCommandsRuntime() {
  return skillCommandsRuntimeLoader.load();
}

function loadStatusCommandRuntime() {
  return statusCommandRuntimeLoader.load();
}

function resolveNativeSlashCommandName(ctx: MsgContext): string | undefined {
  if (!isNativeCommandTurn(resolveCommandTurnContext(ctx))) {
    return undefined;
  }
  const commandText = stripStructuralPrefixes(
    ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "",
  ).trim();
  const match = commandText.match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeOptionalString(match?.[1])?.toLowerCase();
}

function resolveSlashCommandName(commandBodyNormalized: string): string | undefined {
  const match = commandBodyNormalized.trim().match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeOptionalString(match?.[1])?.toLowerCase();
}

function resolveTextCommandBody(ctx: MsgContext): string | undefined {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (!isTextSlashCommandTurn(commandTurn)) {
    return undefined;
  }
  const commandText = stripStructuralPrefixes(
    commandTurn.body ?? ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "",
  ).trim();
  if (!commandText.startsWith("/") || commandText.includes("\n")) {
    return undefined;
  }
  return normalizeCommandBody(commandText, { botUsername: ctx.BotUsername });
}

function shouldRunNativeSlashCommandFastPath(ctx: MsgContext): boolean {
  const commandName = resolveNativeSlashCommandName(ctx);
  return Boolean(commandName && commandName !== "new" && commandName !== "reset");
}

function hasOnlyTextFastPathDirectives(directives: InlineDirectives): boolean {
  const hasAllowedDirective =
    directives.hasThinkDirective ||
    directives.hasVerboseDirective ||
    directives.hasFastDirective ||
    directives.hasReasoningDirective;
  if (!hasAllowedDirective) {
    return false;
  }
  return (
    !directives.hasTraceDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasExecDirective &&
    !directives.hasStatusDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective &&
    directives.cleaned.trim().length === 0
  );
}

function isTextFastPathHandlerCommand(commandName: string, commandBodyNormalized: string): boolean {
  switch (commandName) {
    case "activation":
      return /^\/activation(?:\s+[a-zA-Z]+)?$/i.test(commandBodyNormalized);
    case "send":
      return /^\/send(?:\s+[a-zA-Z]+)?$/i.test(commandBodyNormalized);
    case "usage":
      return /^\/usage(?:\s+(?:off|on|tokens?|tok|minimal|min|full|session|cost|disable|disabled|enable|enabled|false|true|yes|no|0|1))?$/i.test(
        commandBodyNormalized,
      );
    case "whoami":
      return commandBodyNormalized === "/whoami";
    default:
      return false;
  }
}

function resolveTextSlashFastPathIntent(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): TextSlashFastPathIntent | undefined {
  if (
    !shouldHandleTextCommands({
      cfg: params.cfg,
      surface: params.ctx.Surface ?? params.ctx.Provider ?? "",
      commandSource: params.ctx.CommandSource,
    })
  ) {
    return undefined;
  }

  const commandBodyNormalized = resolveTextCommandBody(params.ctx);
  if (!commandBodyNormalized) {
    return undefined;
  }
  const commandName = resolveSlashCommandName(commandBodyNormalized);
  if (!commandName) {
    return undefined;
  }

  if (commandName === "status") {
    const directives = parseInlineDirectives(commandBodyNormalized, {
      allowStatusDirective: true,
    });
    if (directives.hasStatusDirective && directives.cleaned.trim().length === 0) {
      return { kind: "status", commandBodyNormalized };
    }
    return undefined;
  }

  if (TEXT_FAST_PATH_DIRECTIVE_COMMANDS.has(commandName)) {
    const directives = parseInlineDirectives(commandBodyNormalized, {
      allowStatusDirective: false,
    });
    if (hasOnlyTextFastPathDirectives(directives)) {
      return { kind: "directive", commandBodyNormalized };
    }
    return undefined;
  }

  if (
    TEXT_FAST_PATH_COMMAND_HANDLERS.has(commandName) &&
    isTextFastPathHandlerCommand(commandName, commandBodyNormalized)
  ) {
    return { kind: "command", commandBodyNormalized };
  }

  return undefined;
}

function resolveTextFastPathHandlerDirectives(commandBodyNormalized: string): InlineDirectives {
  return clearInlineDirectives(commandBodyNormalized);
}

async function resolveNativeSlashDefaultThinkingLevel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): Promise<ThinkLevel> {
  return resolveThinkingDefaultWithRuntimeCatalog({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    loadModelCatalog: () => loadModelCatalog({ config: params.cfg }),
  });
}

export async function maybeResolveSlashCommandFastReply(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  commandAuthorized: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  workspaceDir: string;
  typing: ReturnType<typeof createTypingController>;
  opts?: GetReplyOptions;
  skillFilter?: string[];
}): Promise<
  { handled: true; reply: ReplyPayload | ReplyPayload[] | undefined } | { handled: false }
> {
  const isNativeSlashFastPath = shouldRunNativeSlashCommandFastPath(params.ctx);
  const textFastPathIntent = resolveTextSlashFastPathIntent({
    ctx: params.ctx,
    cfg: params.cfg,
  });
  if (!isNativeSlashFastPath && !textFastPathIntent) {
    return { handled: false };
  }

  const sessionState = initFastReplySessionState({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    commandAuthorized: params.commandAuthorized,
    workspaceDir: params.workspaceDir,
  });
  const triggerBodyNormalized =
    textFastPathIntent?.commandBodyNormalized ?? sessionState.triggerBodyNormalized;
  const command = buildCommandContext({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: sessionState.sessionKey,
    isGroup: sessionState.isGroup,
    triggerBodyNormalized,
    commandAuthorized: params.commandAuthorized,
  });

  if (textFastPathIntent && !command.isAuthorizedSender) {
    return { handled: true, reply: undefined };
  }

  if (command.commandBodyNormalized === "/status") {
    const targetSessionEntry =
      sessionState.sessionStore[sessionState.sessionKey] ?? sessionState.sessionEntry;
    let resolvedDefaultThinkingLevel: ThinkLevel | undefined;
    const resolveDefaultThinkingLevel = async () => {
      resolvedDefaultThinkingLevel ??= await resolveNativeSlashDefaultThinkingLevel({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
      });
      return resolvedDefaultThinkingLevel;
    };
    const resolvedThinkLevel = normalizeThinkLevel(targetSessionEntry?.thinkingLevel);
    const { buildStatusReply } = await loadStatusCommandRuntime();
    return {
      handled: true,
      reply: await buildStatusReply({
        cfg: params.cfg,
        command,
        sessionEntry: targetSessionEntry,
        sessionKey: sessionState.sessionKey,
        parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
        sessionScope: sessionState.sessionScope,
        storePath: sessionState.storePath,
        provider: params.provider,
        model: params.model,
        workspaceDir: params.workspaceDir,
        resolvedThinkLevel,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        resolveDefaultThinkingLevel,
        isGroup: sessionState.isGroup,
        defaultGroupActivation: () => "always",
        mediaDecisions: params.ctx.MediaUnderstandingDecisions,
      }),
    };
  }

  let loadedSkillCommands: SkillCommandSpec[] | undefined;
  const loadNativeSkillCommands = async () => {
    loadedSkillCommands ??= (await loadSkillCommandsRuntime()).listSkillCommandsForWorkspace({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
    });
    return loadedSkillCommands;
  };

  if (textFastPathIntent?.kind === "command") {
    const commandResult = await (
      await loadCommandsRuntime()
    ).handleCommands({
      ctx: sessionState.sessionCtx,
      rootCtx: params.ctx,
      cfg: params.cfg,
      command,
      agentId: params.agentId,
      agentDir: params.agentDir,
      directives: resolveTextFastPathHandlerDirectives(textFastPathIntent.commandBodyNormalized),
      elevated: {
        enabled: false,
        allowed: false,
        failures: [],
      },
      sessionEntry: sessionState.sessionEntry,
      previousSessionEntry: sessionState.previousSessionEntry,
      sessionStore: sessionState.sessionStore,
      sessionKey: sessionState.sessionKey,
      storePath: sessionState.storePath,
      sessionScope: sessionState.sessionScope,
      workspaceDir: params.workspaceDir,
      opts: params.opts,
      defaultGroupActivation: () => "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: "text_end",
      resolveDefaultThinkingLevel: async () => undefined,
      provider: params.provider,
      model: params.model,
      contextTokens: params.agentCfg?.contextTokens ?? 0,
      isGroup: sessionState.isGroup,
      loadSkillCommands: async () => [],
      typing: params.typing,
    });
    if (!commandResult.shouldContinue) {
      return { handled: true, reply: commandResult.reply };
    }
    return { handled: false };
  }

  if (textFastPathIntent?.kind === "directive") {
    const directiveResult = await resolveReplyDirectives({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      agentCfg: params.agentCfg,
      sessionCtx: sessionState.sessionCtx,
      sessionEntry: sessionState.sessionEntry,
      sessionStore: sessionState.sessionStore,
      sessionKey: sessionState.sessionKey,
      storePath: sessionState.storePath,
      sessionScope: sessionState.sessionScope,
      groupResolution: sessionState.groupResolution,
      isGroup: sessionState.isGroup,
      triggerBodyNormalized,
      resetTriggered: false,
      commandAuthorized: params.commandAuthorized,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      provider: params.provider,
      model: params.model,
      hasResolvedHeartbeatModelOverride: false,
      typing: params.typing,
      opts: params.opts,
      skillFilter: params.skillFilter,
    });
    if (directiveResult.kind === "reply") {
      return { handled: true, reply: directiveResult.reply };
    }
    return { handled: false };
  }

  if (!isNativeSlashFastPath) {
    return { handled: false };
  }

  const commandResult = await (
    await loadCommandsRuntime()
  ).handleCommands({
    ctx: sessionState.sessionCtx,
    rootCtx: params.ctx,
    cfg: params.cfg,
    command,
    agentId: params.agentId,
    agentDir: params.agentDir,
    directives: clearInlineDirectives(sessionState.triggerBodyNormalized),
    elevated: {
      enabled: false,
      allowed: false,
      failures: [],
    },
    sessionEntry: sessionState.sessionEntry,
    previousSessionEntry: sessionState.previousSessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    workspaceDir: params.workspaceDir,
    opts: params.opts,
    defaultGroupActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    blockReplyChunking: undefined,
    resolvedBlockStreamingBreak: "text_end",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: params.provider,
    model: params.model,
    contextTokens: params.agentCfg?.contextTokens ?? 0,
    isGroup: sessionState.isGroup,
    loadSkillCommands: loadNativeSkillCommands,
    typing: params.typing,
  });
  if (!commandResult.shouldContinue) {
    return { handled: true, reply: commandResult.reply };
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    agentCfg: params.agentCfg,
    sessionCtx: sessionState.sessionCtx,
    sessionEntry: sessionState.sessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    groupResolution: sessionState.groupResolution,
    isGroup: sessionState.isGroup,
    triggerBodyNormalized: sessionState.triggerBodyNormalized,
    resetTriggered: false,
    commandAuthorized: params.commandAuthorized,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    provider: params.provider,
    model: params.model,
    hasResolvedHeartbeatModelOverride: false,
    typing: params.typing,
    opts: params.opts,
    skillFilter: params.skillFilter,
  });
  if (directiveResult.kind === "reply") {
    return { handled: true, reply: directiveResult.reply };
  }

  const inlineActionResult = await handleInlineActions({
    ctx: params.ctx,
    sessionCtx: sessionState.sessionCtx,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    sessionEntry: sessionState.sessionEntry,
    previousSessionEntry: sessionState.previousSessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    workspaceDir: params.workspaceDir,
    isGroup: sessionState.isGroup,
    opts: params.opts,
    typing: params.typing,
    allowTextCommands: directiveResult.result.allowTextCommands,
    inlineStatusRequested: directiveResult.result.inlineStatusRequested,
    command: directiveResult.result.command,
    skillCommands: loadedSkillCommands ?? directiveResult.result.skillCommands,
    directives: directiveResult.result.directives,
    cleanedBody: directiveResult.result.cleanedBody,
    elevatedEnabled: directiveResult.result.elevatedEnabled,
    elevatedAllowed: directiveResult.result.elevatedAllowed,
    elevatedFailures: directiveResult.result.elevatedFailures,
    defaultActivation: () => directiveResult.result.defaultActivation,
    resolvedThinkLevel: directiveResult.result.resolvedThinkLevel,
    resolvedVerboseLevel: directiveResult.result.resolvedVerboseLevel,
    resolvedReasoningLevel: directiveResult.result.resolvedReasoningLevel,
    resolvedElevatedLevel: directiveResult.result.resolvedElevatedLevel,
    blockReplyChunking: directiveResult.result.blockReplyChunking,
    resolvedBlockStreamingBreak: directiveResult.result.resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel: directiveResult.result.modelState.resolveDefaultThinkingLevel,
    provider: directiveResult.result.provider,
    model: directiveResult.result.model,
    contextTokens: directiveResult.result.contextTokens,
    directiveAck: directiveResult.result.directiveAck,
    abortedLastRun: sessionState.abortedLastRun,
    skillFilter: params.skillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    return { handled: true, reply: inlineActionResult.reply };
  }
  return { handled: false };
}
