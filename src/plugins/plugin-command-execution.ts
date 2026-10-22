/** Exact-registry plugin command execution shared by focused and compatibility runtimes. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveBoundAgentIdForSession } from "../agents/session-agent-binding.js";
import { resolveCommandConversationResolution } from "../channels/conversation-resolution.js";
import { ADMIN_SCOPE, isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import { withPluginCommandExecution } from "./command-execution-lock.js";
import { isReservedCommandName } from "./command-registration.js";
import {
  canExposeSenderIsOwner,
  isTrustedReservedCommandOwner,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { pluginCommandSupportsChannel } from "./plugin-command-metadata.js";
import type { PluginCommandDispatchContext } from "./plugin-command-runtime.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";

const MAX_ARGS_LENGTH = 4096;
const blockedCompaction = (reason: string) => ({ compacted: false, reason });

export type PluginCommandExecutionParams = PluginCommandDispatchContext & {
  command: RegisteredPluginCommand;
  args?: string;
};

function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
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

async function buildRuntimeContext(
  registry: PluginRegistry,
  command: RegisteredPluginCommand,
  params: PluginCommandDispatchContext,
  invocationSignal: AbortSignal,
  assertOwnerCurrent?: () => void,
  scheduled?: true,
): Promise<PluginCommandContext["runtimeContext"]> {
  const sessionKey = params.sessionKey?.trim();
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    agentId: params.agentId,
    sessionKey,
  });
  const compactCurrent = params.runtimeContext?.compactCurrent;
  if (!sessionKey && !agentId) {
    return undefined;
  }
  const pluginAuthority = capturePluginLifecycleAuthority(
    registry,
    registry.plugins.find((record) => record.id === command.pluginId),
    { scopedRuntime: true },
  );
  const assertInvocationCurrent = () => {
    invocationSignal.throwIfAborted();
    if (!pluginAuthority?.()) {
      throw new Error("Plugin command runtime is no longer active.");
    }
    params.assertOwnerCurrent?.();
  };
  const subagents =
    command.runtimeCapabilities?.includes("subagents") &&
    command.requireAuth === true &&
    params.isAuthorizedSender
      ? await params.runtimeContext?.createSubagents?.({
          pluginId: command.pluginId,
          command: {
            requireAuth: command.requireAuth,
            runtimeCapabilities: command.runtimeCapabilities,
          },
          signal: invocationSignal,
          assertCurrent: assertInvocationCurrent,
        })
      : undefined;
  if (subagents) {
    assertInvocationCurrent();
  } else if (scheduled) {
    throw new Error("Scheduled command requires current native subagent eligibility.");
  }
  return {
    ...(subagents
      ? {
          // Project the public helpers only: scheduling stays outside the subagents object.
          subagents: {
            spawn: (request) => subagents.spawn(request),
            collect: (request) => subagents.collect(request),
            ...(subagents.list ? { list: subagents.list } : {}),
          },
        }
      : {}),
    ...(subagents?.scheduledTurns && command.runtimeCapabilities?.includes("scheduledTurns")
      ? { scheduledTurns: subagents.scheduledTurns }
      : {}),
    ...(command.runtimeCapabilities?.includes("models") && params.isAuthorizedSender
      ? {
          models: params.runtimeContext?.createModels?.({
            signal: invocationSignal,
            assertCurrent: assertInvocationCurrent,
          }),
        }
      : {}),
    llm: {
      complete: async (request) => {
        assertInvocationCurrent();
        if (scheduled) {
          throw new Error(
            "Scheduled commands must use their admitted native subagent runtime for model work.",
          );
        }
        const { createRuntimeLlm } = await import("./runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: {
              kind: "plugin",
              id: command.pluginId,
              name: command.pluginName,
            },
            pluginIdForPolicy: command.pluginId,
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
    ...(compactCurrent && params.sessionTarget
      ? {
          // Command capabilities require this live invocation; retained references fail closed.
          compactCurrent: async () => {
            if (invocationSignal.aborted) {
              return blockedCompaction("command invocation closed");
            }
            return await compactCurrent(invocationSignal, assertOwnerCurrent);
          },
        }
      : {}),
  };
}

export async function executeRegisteredPluginCommand(
  registry: PluginRegistry,
  params: PluginCommandExecutionParams,
  scheduled?: { abortSignal: AbortSignal },
): Promise<PluginCommandResult> {
  const assertAdmittedOwner = params.assertOwnerCurrent;
  scheduled?.abortSignal.throwIfAborted();
  const refuse = (text: string): PluginCommandResult => {
    if (scheduled) {
      throw new Error(text);
    }
    return { text };
  };
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;
  if (!pluginCommandSupportsChannel(command, channel)) {
    logVerbose(`Plugin command /${command.name} skipped on unsupported channel ${channel}`);
    if (scheduled) {
      throw new Error("Scheduled command channel is unavailable.");
    }
    return { continueAgent: true };
  }
  if (command.requireAuth !== false && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return refuse("⚠️ This command requires authorization.");
  }
  if (command.requiredScopes !== undefined && !Array.isArray(command.requiredScopes)) {
    logVerbose(`Plugin command /${command.name} blocked: invalid requiredScopes configuration`);
    return refuse("⚠️ This command has invalid gateway scope configuration.");
  }
  const requiredScopes = command.requiredScopes ?? [];
  for (const scope of requiredScopes) {
    if (!isOperatorScope(scope)) {
      logVerbose(`Plugin command /${command.name} blocked: unknown gateway scope`);
      return refuse("⚠️ This command has invalid gateway scope configuration.");
    }
  }
  if (requiredScopes.length > 0) {
    const scopes = Array.isArray(params.gatewayClientScopes)
      ? new Set(params.gatewayClientScopes)
      : undefined;
    const hasAdmin = scopes?.has(ADMIN_SCOPE) === true;
    const missingScope = scopes
      ? requiredScopes.find((scope) => !hasAdmin && !scopes.has(scope))
      : requiredScopes[0];
    if (missingScope && (scopes !== undefined || params.senderIsOwner !== true)) {
      logVerbose(`Plugin command /${command.name} blocked: missing gateway scope ${missingScope}`);
      return refuse(`⚠️ This command requires gateway scope: ${missingScope}.`);
    }
  }

  const channelPlugin = registry.channels.find((entry) => entry.plugin.id === channel)?.plugin;
  const bindingConversation = channelPlugin?.bindings?.resolveCommandConversation
    ? resolveCommandConversationResolution({
        cfg: config,
        plugin: channelPlugin,
        channel,
        accountId: params.accountId,
        threadId: params.messageThreadId,
        threadParentId: params.threadParentId,
        senderId,
        originatingTo: params.originatingTo ?? params.from,
        commandTo: params.to,
        fallbackTo: params.to ?? params.from,
      })
    : null;
  const trustedReservedOwner =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name);
  const senderIsOwner =
    canExposeSenderIsOwner(command) || trustedReservedOwner ? params.senderIsOwner : undefined;
  const commandInvocationAbort = new AbortController();
  const invocationSignal = scheduled
    ? AbortSignal.any([commandInvocationAbort.signal, scheduled.abortSignal])
    : commandInvocationAbort.signal;
  const assertOwnerCurrent =
    senderIsOwner === true
      ? () => {
          if (commandInvocationAbort.signal.aborted) {
            throw new Error("Plugin command invocation closed.");
          }
          assertAdmittedOwner?.();
        }
      : undefined;
  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
    ...(assertOwnerCurrent ? { assertOwnerCurrent } : {}),
    gatewayClientScopes: params.gatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    args: sanitizeArgs(args),
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: bindingConversation?.accountId ?? params.accountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    diagnosticsSessions: params.diagnosticsSessions,
    ...(trustedReservedOwner && params.diagnosticsUploadApproved !== undefined
      ? { diagnosticsUploadApproved: params.diagnosticsUploadApproved }
      : {}),
    ...(trustedReservedOwner && params.diagnosticsPreviewOnly !== undefined
      ? { diagnosticsPreviewOnly: params.diagnosticsPreviewOnly }
      : {}),
    ...(trustedReservedOwner && params.diagnosticsPrivateRouted !== undefined
      ? { diagnosticsPrivateRouted: params.diagnosticsPrivateRouted }
      : {}),
    requestConversationBinding: async (bindingParams) => {
      if (!command.pluginRoot || !bindingConversation) {
        return { status: "error", message: "This command cannot bind the current conversation." };
      }
      return requestPluginConversationBinding({
        pluginId: command.pluginId,
        pluginName: command.pluginName,
        pluginRoot: command.pluginRoot,
        requestedBySenderId: senderId,
        conversation: bindingConversation,
        binding: bindingParams,
        assertCurrent: assertOwnerCurrent,
      });
    },
    detachConversationBinding: async () =>
      command.pluginRoot && bindingConversation
        ? detachPluginConversationBinding({
            pluginRoot: command.pluginRoot,
            conversation: bindingConversation,
          })
        : { removed: false },
    getCurrentConversationBinding: async () =>
      command.pluginRoot && bindingConversation
        ? getCurrentPluginConversationBinding({
            pluginRoot: command.pluginRoot,
            conversation: bindingConversation,
          })
        : null,
  };

  try {
    const execution = await withPluginCommandExecution(registry, async () => {
      ctx.runtimeContext = await buildRuntimeContext(
        registry,
        command,
        params,
        invocationSignal,
        assertOwnerCurrent,
        scheduled ? true : undefined,
      );
      if (requiredScopes.length > 0 && !Array.isArray(params.gatewayClientScopes)) {
        assertOwnerCurrent?.();
      }
      invocationSignal.throwIfAborted();
      if (scheduled) {
        assertAdmittedOwner?.();
      }
      const result = await command.handler(ctx);
      if (scheduled) {
        invocationSignal.throwIfAborted();
        assertAdmittedOwner?.();
      }
      return result;
    });
    if (!execution.admitted) {
      return refuse(
        "⚠️ This command is no longer available after the plugin registry changed. Please try again.",
      );
    }
    const result = execution.value;
    if (!result || typeof result !== "object") {
      return {};
    }
    return result;
  } catch (error) {
    if (scheduled) {
      throw error;
    }
    logVerbose(`Plugin command /${command.name} execution failed (plugin=${command.pluginId})`);
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    commandInvocationAbort.abort("command invocation closed");
  }
}
