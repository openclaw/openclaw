/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveBoundAgentIdForSession } from "../agents/session-agent-binding.js";
import { resolveConversationBindingContext } from "../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
  normalizeAuthorizationCommandSource,
} from "./authorization-policy-context.js";
import { runAuthorizationPolicies } from "./authorization-policy.js";
import type {
  AuthorizationInvocationContext,
  TurnAuthoritySnapshot,
} from "./authorization-policy.types.js";
import {
  clearPluginCommands,
  isReservedCommandName,
  listPluginInvocationKeys,
  pluginCommandSupportsChannel,
  registerPluginCommand,
} from "./command-registration.js";
import {
  canExposeSenderIsOwner,
  isTrustedReservedCommandOwner,
  listRegisteredPluginAgentPromptGuidance,
  pluginCommands,
  setPluginCommandRegistryLocked,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
import { classifyTurnAuthoritySnapshot, rebindTurnAuthoritySnapshot } from "./turn-authority.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

export { clearPluginCommands, listRegisteredPluginAgentPromptGuidance, registerPluginCommand };

/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export function matchPluginCommand(
  commandBody: string,
  options: { channel?: string } = {},
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Accept whitespace after the slash so `/ pair qr` keeps `/pair` ownership.
  const commandMatch = trimmed.match(/^\/\s*([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return null;
  }
  const commandName = `/${commandMatch[1]}`;
  const args = commandMatch[2]?.trim();

  const key = normalizeLowercaseStringOrEmpty(commandName);
  const alternateKeys = [key];
  if (key.includes("_")) {
    alternateKeys.push(key.replace(/_/g, "-"));
  }
  if (key.includes("-")) {
    alternateKeys.push(key.replace(/-/g, "_"));
  }
  const command =
    alternateKeys
      .map(
        (candidateKey) =>
          pluginCommands.get(candidateKey) ??
          Array.from(pluginCommands.values()).find((candidate) =>
            listPluginInvocationNames(candidate).includes(candidateKey),
          ),
      )
      .filter((candidate) => candidate && pluginCommandSupportsChannel(candidate, options.channel))
      .find(Boolean) ?? null;

  if (!command) {
    return null;
  }

  // If command doesn't accept args but args were provided, don't match
  if (args && !command.acceptsArgs) {
    return null;
  }

  return { command, args: args || undefined };
}

/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }

  // Remove control characters (except newlines and tabs which may be intentional)
  let sanitized = "";
  for (const char of truncateUtf16Safe(args, MAX_ARGS_LENGTH)) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}

function resolveBindingConversationFromCommand(params: {
  config?: OpenClawConfig;
  channel: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
}): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
} | null {
  const channelPlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === params.channel,
  )?.plugin;
  if (!channelPlugin?.bindings?.resolveCommandConversation) {
    return null;
  }
  return resolveConversationBindingContext({
    cfg: params.config ?? ({} as OpenClawConfig),
    channel: params.channel,
    accountId: params.accountId,
    threadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    senderId: params.senderId,
    originatingTo: params.from,
    commandTo: params.to,
    fallbackTo: params.to ?? params.from,
  });
}

type PluginCommandRuntimeLlm = NonNullable<PluginCommandContext["runtimeContext"]>["llm"];
type PluginCommandLlmCompleteParams = Parameters<
  NonNullable<PluginCommandRuntimeLlm>["complete"]
>[0];

function buildPluginCommandRuntimeContext(params: {
  command: RegisteredPluginCommand;
  config: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  authProfileId?: string;
}): PluginCommandContext["runtimeContext"] {
  const sessionKey = params.sessionKey?.trim();
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    agentId: params.agentId,
    sessionKey,
  });
  if (!sessionKey && !agentId) {
    return undefined;
  }
  return {
    llm: {
      complete: async (request: PluginCommandLlmCompleteParams) => {
        const { createRuntimeLlm } = await import("./runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: {
              kind: "plugin",
              id: params.command.pluginId,
              name: params.command.pluginName,
            },
            pluginIdForPolicy: params.command.pluginId,
            requiresBoundAgent: true,
            ...(sessionKey ? { sessionKey } : {}),
            ...(agentId ? { agentId } : {}),
            ...(params.authProfileId ? { preferredProfile: params.authProfileId } : {}),
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}

/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
type ExecutePluginCommandParams = {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  memberRoleIds?: string[];
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  senderIsOwner?: boolean;
  gatewayClientScopes?: PluginCommandContext["gatewayClientScopes"];
  /** Host-resolved agent authority for plugin-owned or non-agent-shaped session keys. */
  agentId?: string;
  sessionKey?: PluginCommandContext["sessionKey"];
  sessionId?: PluginCommandContext["sessionId"];
  sessionFile?: PluginCommandContext["sessionFile"];
  authProfileId?: string;
  commandBody: string;
  commandSource?: unknown;
  abortSignal?: AbortSignal;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
  threadParentId?: PluginCommandContext["threadParentId"];
  /** Host-resolved conversation identity; never derived from a provider id. */
  conversationId?: string;
  parentConversationId?: string;
  /** Internal channel callback run after authorization and before the command handler. */
  onAuthorized?: () => Promise<void> | void;
  diagnosticsSessions?: PluginCommandContext["diagnosticsSessions"];
  diagnosticsUploadApproved?: PluginCommandContext["diagnosticsUploadApproved"];
  diagnosticsPreviewOnly?: PluginCommandContext["diagnosticsPreviewOnly"];
  diagnosticsPrivateRouted?: PluginCommandContext["diagnosticsPrivateRouted"];
};

type HostExecutePluginCommandParams = ExecutePluginCommandParams & {
  /** Internal host-issued authority. Never sourced from plugin or model input. */
  turnAuthority?: TurnAuthoritySnapshot;
};

type CommandAuthorityTarget = { agentId: string; sessionKey: string; sessionId?: string };

function resolveCommandAuthorityTarget(params: {
  config: OpenClawConfig;
  source: Readonly<AuthorizationInvocationContext>;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}): CommandAuthorityTarget | undefined {
  const explicitAgentId =
    params.agentId === undefined
      ? undefined
      : resolveBoundAgentIdForSession({ config: params.config, agentId: params.agentId });
  const explicitSessionKey = normalizeOptionalString(params.sessionKey);
  if (
    (params.agentId !== undefined && !explicitAgentId) ||
    (params.sessionKey !== undefined && !explicitSessionKey)
  ) {
    return undefined;
  }

  const sourceAgentId = params.source.agentId
    ? resolveBoundAgentIdForSession({ config: params.config, agentId: params.source.agentId })
    : undefined;
  const sourceSessionKey = normalizeOptionalString(params.source.sessionKey);
  const sessionKey = explicitSessionKey ?? sourceSessionKey;
  if (!sessionKey) {
    return undefined;
  }

  const sessionAgentId = resolveBoundAgentIdForSession({
    config: params.config,
    sessionKey,
  });
  const agentId =
    explicitAgentId ??
    sessionAgentId ??
    (sessionKey === sourceSessionKey ? sourceAgentId : undefined);
  if (
    !agentId ||
    (sessionAgentId !== undefined && sessionAgentId !== agentId) ||
    (sessionKey === sourceSessionKey && sourceAgentId !== undefined && sourceAgentId !== agentId)
  ) {
    return undefined;
  }

  const sourceSessionId = normalizeOptionalString(params.source.sessionId);
  const sessionId =
    normalizeOptionalString(params.sessionId) ??
    (sessionKey === sourceSessionKey ? sourceSessionId : undefined);
  return { agentId, sessionKey, ...(sessionId ? { sessionId } : {}) };
}

export async function executePluginCommand(
  params: ExecutePluginCommandParams,
): Promise<PluginCommandResult> {
  return await executePluginCommandInternal(params);
}

/** Host-only command entry point preserving the authority admitted for this turn. */
export async function executePluginCommandWithTurnAuthority(
  params: HostExecutePluginCommandParams,
): Promise<PluginCommandResult> {
  return await executePluginCommandInternal(params);
}

async function executePluginCommandInternal(
  params: HostExecutePluginCommandParams,
): Promise<PluginCommandResult> {
  const { command, args, channel, commandBody, config } = params;
  const classifiedAuthority = classifyTurnAuthoritySnapshot(params.turnAuthority);
  if (classifiedAuthority.kind === "invalid") {
    logVerbose(`Plugin command /${command.name} blocked: invalid turn authority`);
    return { text: "⚠️ This command requires authorization." };
  }
  const sourceTurnAuthority =
    classifiedAuthority.kind === "issued" ? classifiedAuthority.snapshot : undefined;
  const sourceTurnAuthorization = sourceTurnAuthority?.authorization;
  let commandAuthorityTarget: CommandAuthorityTarget | undefined;
  let commandTurnAuthority: TurnAuthoritySnapshot | undefined;
  if (sourceTurnAuthorization) {
    commandAuthorityTarget = resolveCommandAuthorityTarget({
      config,
      source: sourceTurnAuthorization,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    if (!commandAuthorityTarget) {
      logVerbose(`Plugin command /${command.name} blocked: unresolved command authority target`);
      return { text: "⚠️ This command requires authorization." };
    }
    commandTurnAuthority = rebindTurnAuthoritySnapshot(sourceTurnAuthority, {
      agentId: commandAuthorityTarget.agentId,
      sessionKey: commandAuthorityTarget.sessionKey,
      sessionId: commandAuthorityTarget.sessionId,
      runId: sourceTurnAuthorization.runId,
      trigger: "command",
    });
    if (!commandTurnAuthority) {
      logVerbose(`Plugin command /${command.name} blocked: command authority rebind failed`);
      return { text: "⚠️ This command requires authorization." };
    }
  }
  const turnAuthorization = commandTurnAuthority?.authorization;
  const agentId = commandAuthorityTarget?.agentId ?? params.agentId;
  const sessionKey = commandAuthorityTarget?.sessionKey ?? params.sessionKey;
  const sessionId = commandAuthorityTarget?.sessionId ?? params.sessionId;
  // Once admitted, identity and scopes come only from the immutable snapshot.
  // Legacy channel fields remain a compatibility path for callers without one.
  const principal = turnAuthorization?.principal;
  const senderId = turnAuthorization
    ? principal?.kind === "sender"
      ? principal.senderId
      : undefined
    : params.senderId;
  const isAuthorizedSender = turnAuthorization
    ? principal?.kind === "sender"
      ? principal.isAuthorizedSender === true
      : principal?.kind === "operator" || principal?.kind === "service"
    : params.isAuthorizedSender;
  const senderIsOwner = turnAuthorization
    ? principal?.kind === "sender"
      ? principal.senderIsOwner === true
      : principal?.kind === "operator"
        ? principal.isOwner === true
        : false
    : params.senderIsOwner === true;
  const gatewayClientScopes = turnAuthorization
    ? principal?.kind === "operator"
      ? [...principal.scopes]
      : undefined
    : params.gatewayClientScopes;

  // Check authorization
  if (!pluginCommandSupportsChannel(command, channel)) {
    logVerbose(`Plugin command /${command.name} skipped on unsupported channel ${channel}`);
    return { continueAgent: true };
  }
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }
  if (command.requiredScopes !== undefined && !Array.isArray(command.requiredScopes)) {
    logVerbose(`Plugin command /${command.name} blocked: invalid requiredScopes configuration`);
    return { text: "⚠️ This command has invalid gateway scope configuration." };
  }
  const requiredScopes = command.requiredScopes ?? [];
  const unknownScope = (requiredScopes as readonly unknown[]).find(
    (scope) => !isOperatorScope(scope),
  );
  if (unknownScope) {
    logVerbose(`Plugin command /${command.name} blocked: unknown gateway scope`);
    return { text: "⚠️ This command has invalid gateway scope configuration." };
  }
  if (requiredScopes.length > 0) {
    const scopes = Array.isArray(gatewayClientScopes) ? new Set(gatewayClientScopes) : undefined;
    const hasGatewayScopeContext = scopes !== undefined;
    const hasAdmin = scopes?.has(ADMIN_SCOPE) === true;
    const missingScope = scopes
      ? requiredScopes.find((scope) => !hasAdmin && !scopes.has(scope))
      : requiredScopes[0];
    if (missingScope && (hasGatewayScopeContext || !senderIsOwner)) {
      logVerbose(`Plugin command /${command.name} blocked: missing gateway scope ${missingScope}`);
      return { text: `⚠️ This command requires gateway scope: ${missingScope}.` };
    }
  }

  // Sanitize args before passing to handler
  const sanitizedArgs = sanitizeArgs(args);
  const bindingConversation = resolveBindingConversationFromCommand({
    config,
    channel,
    senderId,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
  });
  const effectiveAccountId = bindingConversation?.accountId ?? params.accountId;
  const policyDenial = await runAuthorizationPolicies({
    request: {
      operation: "command.invoke",
      phase: "final",
      commandName: command.name,
      owner: {
        kind: "plugin",
        pluginId: command.pluginId,
        ...(command.pluginName ? { pluginName: command.pluginName } : {}),
      },
      source: normalizeAuthorizationCommandSource(params.commandSource),
      ...(sanitizedArgs ? { arguments: { raw: sanitizedArgs } } : {}),
    },
    context:
      turnAuthorization ??
      createAuthorizationInvocationContext({
        principal: createAuthorizationPrincipal({
          provider: channel,
          // Conversation resolution preserves the ingress account, defaulting it from host config;
          // provider target resolution cannot replace it with a destination account.
          accountId: effectiveAccountId,
          senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner,
          isAuthorizedSender,
          roleIds: params.memberRoleIds,
        }),
        agentId,
        sessionKey,
        sessionId,
        conversationId: params.conversationId ?? bindingConversation?.conversationId,
        parentConversationId:
          params.parentConversationId ??
          bindingConversation?.parentConversationId ??
          params.threadParentId,
        threadId: params.messageThreadId,
        trigger: "command",
      }),
    config,
    signal: params.abortSignal,
  });
  params.abortSignal?.throwIfAborted();
  if (policyDenial) {
    logVerbose(
      `Plugin command /${command.name} blocked by authorization policy ${policyDenial.policyId}`,
    );
    return { text: "⚠️ Command blocked by authorization policy." };
  }
  await params.onAuthorized?.();
  params.abortSignal?.throwIfAborted();
  const senderIsOwnerForCommand =
    canExposeSenderIsOwner(command) ||
    (isTrustedReservedCommandOwner(command) &&
      command.ownership === "reserved" &&
      isReservedCommandName(command.name) &&
      command.pluginId === normalizeLowercaseStringOrEmpty(command.name))
      ? senderIsOwner
      : undefined;
  const diagnosticsPrivateRoutedForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsPrivateRouted
      : undefined;
  const diagnosticsUploadApprovedForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsUploadApproved
      : undefined;
  const diagnosticsPreviewOnlyForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsPreviewOnly
      : undefined;

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    ...(senderIsOwnerForCommand === undefined ? {} : { senderIsOwner: senderIsOwnerForCommand }),
    gatewayClientScopes,
    agentId,
    sessionKey,
    sessionId,
    sessionFile: params.sessionFile,
    args: sanitizedArgs,
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: effectiveAccountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    diagnosticsSessions: params.diagnosticsSessions,
    runtimeContext: buildPluginCommandRuntimeContext({
      command,
      config,
      agentId,
      sessionKey,
      authProfileId: params.authProfileId,
    }),
    ...(diagnosticsUploadApprovedForCommand === undefined
      ? {}
      : { diagnosticsUploadApproved: diagnosticsUploadApprovedForCommand }),
    ...(diagnosticsPreviewOnlyForCommand === undefined
      ? {}
      : { diagnosticsPreviewOnly: diagnosticsPreviewOnlyForCommand }),
    ...(diagnosticsPrivateRoutedForCommand === undefined
      ? {}
      : { diagnosticsPrivateRouted: diagnosticsPrivateRoutedForCommand }),
    requestConversationBinding: async (bindingParams) => {
      if (!command.pluginRoot || !bindingConversation) {
        return {
          status: "error",
          message: "This command cannot bind the current conversation.",
        };
      }
      return requestPluginConversationBinding({
        pluginId: command.pluginId,
        pluginName: command.pluginName,
        pluginRoot: command.pluginRoot,
        requestedBySenderId: senderId,
        conversation: bindingConversation,
        binding: bindingParams,
      });
    },
    detachConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
  };

  // Lock registry during execution to prevent concurrent modifications
  setPluginCommandRegistryLocked(true);
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    if (!result || typeof result !== "object") {
      logVerbose(`Plugin command /${command.name} returned no reply payload`);
      return {};
    }
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    // Don't leak internal error details - return a safe generic message
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    setPluginCommandRegistryLocked(false);
  }
}

/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}

function listPluginInvocationNames(command: OpenClawPluginCommandDefinition): string[] {
  return listPluginInvocationKeys(command);
}
