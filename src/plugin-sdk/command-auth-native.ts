/**
 * Public SDK subpath for native command specs, parsing, and authorization helpers.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
} from "../plugins/authorization-policy-context.js";
import {
  runAuthorizationPolicies,
  type AuthorizationPolicyDenial,
} from "../plugins/authorization-policy.js";

/** Host-side final policy gate for channel-native core command shortcuts. */
export async function authorizeNativeCoreCommand(params: {
  commandName: string;
  config: OpenClawConfig;
  provider: string;
  accountId?: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isAuthorizedSender?: boolean;
  roleIds?: readonly string[];
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
  rawArguments?: string;
  signal?: AbortSignal;
}): Promise<AuthorizationPolicyDenial | undefined> {
  const rawArguments = params.rawArguments?.trim();
  return await runAuthorizationPolicies({
    request: {
      operation: "command.invoke",
      phase: "final",
      commandName: params.commandName,
      owner: { kind: "core" },
      source: "native",
      ...(rawArguments ? { arguments: { raw: rawArguments } } : {}),
    },
    context: createAuthorizationInvocationContext({
      principal: createAuthorizationPrincipal({
        provider: params.provider,
        accountId: params.accountId,
        senderId: params.senderId,
        senderIsOwner: params.senderIsOwner,
        isAuthorizedSender: params.isAuthorizedSender,
        roleIds: params.roleIds,
      }),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
      threadId: params.threadId,
      trigger: "command",
    }),
    config: params.config,
    signal: params.signal,
  });
}

export {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listChatCommands,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  maybeResolveTextAlias,
  normalizeCommandBody,
  parseCommandArgs,
  serializeCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
export type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export {
  hasControlCommand,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
} from "../channels/command-gating.js";
export { resolveNativeCommandSessionTargets } from "../channels/native-command-session-targets.js";
export {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "../auto-reply/command-auth.js";
export { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
export {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  resolveFastModeState,
} from "../agents/fast-mode.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { listSkillCommandsForAgents } from "../skills/discovery/chat-commands.js";
export { listProviderPluginCommandSpecs } from "../plugins/command-specs.js";
