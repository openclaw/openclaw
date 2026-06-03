/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Use channel ingress/runtime authorization helpers or command-status helpers
 * instead of this broad compatibility surface.
 */

import {
  buildCommandsMessage as buildCommandsMessageCompat,
  buildCommandsMessagePaginated as buildCommandsMessagePaginatedCompat,
  buildHelpMessage as buildHelpMessageCompat,
} from "../auto-reply/command-status-builders.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  expandAllowFromWithAccessGroups,
  type AccessGroupMembershipResolver,
} from "./access-groups.js";
import { resolveDmGroupAccessWithLists } from "./channel-access-compat.js";
export {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
  resolveAccessGroupAllowFromMatches,
  resolveAccessGroupAllowFromState,
  type AccessGroupMembershipResolver,
  type AccessGroupMembershipLookup,
  type ResolvedAccessGroupAllowFromState,
} from "./access-groups.js";
export { buildCommandsPaginationKeyboard } from "./telegram-command-ui.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "../channels/direct-dm-access.js";

export {
  hasControlCommand,
  hasInlineCommandTokens,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export {
  buildCommandText,
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  getCommandDetection,
  isCommandEnabled,
  isCommandMessage,
  isNativeCommandSurface,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  maybeResolveTextAlias,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  resolveTextCommand,
  serializeCommandArgs,
  shouldHandleTextCommands,
} from "../auto-reply/commands-registry.js";
export type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  CommandScope,
  NativeCommandSpec,
  ResolvedCommandArgChoice,
  ShouldHandleTextCommandsParams,
} from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
  resolveDualTextControlCommandGate,
  type CommandAuthorizer,
  type CommandGatingModeWhenAccessGroupsOff,
} from "../channels/command-gating.js";
export {
  resolveNativeCommandSessionTargets,
  type ResolveNativeCommandSessionTargetsParams,
} from "../channels/native-command-session-targets.js";
export {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "../auto-reply/command-auth.js";
export {
  listReservedChatSlashCommandNames,
  listSkillCommandsForAgents,
  listSkillCommandsForWorkspace,
  resolveSkillCommandInvocation,
} from "../skills/discovery/chat-commands.js";
export { getPluginCommandSpecs, listProviderPluginCommandSpecs } from "../plugins/command-specs.js";
export type { SkillCommandSpec } from "../skills/types.js";
export {
  buildModelsProviderData,
  formatModelsAvailableHeader,
  resolveModelsCommandReply,
} from "../auto-reply/reply/commands-models.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export type { StoredModelOverride } from "../auto-reply/reply/stored-model-override.js";

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveSenderCommandAuthorizationParams = {
  /** Canonical host config; command access-group policy is read from `commands.useAccessGroups`. */
  cfg: OpenClawConfig;
  /** Raw channel text before command parsing. Non-command input must not emit a command decision. */
  rawBody: string;
  /** Group messages use only configured group allowlists for command authorization. */
  isGroup: boolean;
  /** Direct-message access mode; pairing-style modes may add stored DM owners for DM commands only. */
  dmPolicy: string;
  /** Configured direct-message owners before channel access-group expansion. */
  configuredAllowFrom: string[];
  /** Configured group command senders before channel access-group expansion. */
  configuredGroupAllowFrom?: string[];
  /** Transport-local sender id passed through the channel matcher unchanged. */
  senderId: string;
  /** Channel matcher owns id normalization and wildcard/provider-specific matching. */
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  /** Channel/account scope for expanding access-group entries; omitted keeps raw allowlists. */
  channel?: ChannelId;
  accountId?: string;
  resolveAccessGroupMembership?: AccessGroupMembershipResolver;
  /** Pairing-store direct-message owners; ignored for groups, open policy, and allowlist policy. */
  readAllowFromStore: () => Promise<string[]>;
  /** Runtime command detector. False preserves access facts without producing command auth. */
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  /** @deprecated Command authorization is resolved by channel ingress. Kept for runtime injection compatibility. */
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type CommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<
  ResolveSenderCommandAuthorizationParams,
  "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"
> & {
  runtime: CommandAuthorizationRuntime;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): "disabled" | "unauthorized" | "allowed" {
  if (params.isGroup) {
    return "allowed";
  }
  if (params.dmPolicy === "disabled") {
    return "disabled";
  }
  if (!params.senderAllowedForCommands) {
    return "unauthorized";
  }
  return "allowed";
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveSenderCommandAuthorizationWithRuntime(
  params: ResolveSenderCommandAuthorizationWithRuntimeParams,
): ReturnType<typeof resolveSenderCommandAuthorization> {
  return resolveSenderCommandAuthorization({
    ...params,
    shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
    resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers,
  });
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveSenderCommandAuthorization(
  params: ResolveSenderCommandAuthorizationParams,
): Promise<{
  shouldComputeAuth: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}> {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  // Pairing-store owners authorize direct-message command replies only. Groups and open/allowlist
  // policies must rely on configured allowlists so a paired DM cannot become group command access.
  const storeAllowFrom =
    !params.isGroup && params.dmPolicy !== "allowlist" && params.dmPolicy !== "open"
      ? await params.readAllowFromStore().catch(() => [])
      : [];
  const channel = params.channel;
  const accountId = params.accountId ?? "default";
  let configuredAllowFrom = params.configuredAllowFrom;
  let configuredGroupAllowFrom = params.configuredGroupAllowFrom ?? [];
  let dmStoreAllowFrom = storeAllowFrom;
  if (channel) {
    // Expand each allowlist independently; configured DM, configured group, and stored DM owners
    // feed different authorizers and must not collapse into one shared sender list.
    [configuredAllowFrom, configuredGroupAllowFrom] = await Promise.all([
      expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: params.configuredAllowFrom,
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      }),
      expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: params.configuredGroupAllowFrom ?? [],
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      }),
    ]);
    if (!params.isGroup) {
      dmStoreAllowFrom = await expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: storeAllowFrom,
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      });
    }
  }
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: "allowlist",
    allowFrom: configuredAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
    storeAllowFrom: dmStoreAllowFrom,
    isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom),
  });
  const effectiveAllowFrom = access.effectiveAllowFrom;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
  );
  const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? (params.resolveCommandAuthorizedFromAuthorizers?.({
        useAccessGroups,
        // Empty configured lists are treated as absent authorizers. This preserves the legacy
        // fallback where direct sender access decides only when no runtime authorizer is injected.
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: ownerAllowedForCommands },
          { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
        ],
      }) ?? senderAllowedForCommands)
    : undefined;

  return {
    shouldComputeAuth,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildCommandsMessage(
  ...args: Parameters<typeof buildCommandsMessageCompat>
): ReturnType<typeof buildCommandsMessageCompat> {
  return buildCommandsMessageCompat(...args);
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildCommandsMessagePaginated(
  ...args: Parameters<typeof buildCommandsMessagePaginatedCompat>
): ReturnType<typeof buildCommandsMessagePaginatedCompat> {
  return buildCommandsMessagePaginatedCompat(...args);
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildHelpMessage(
  ...args: Parameters<typeof buildHelpMessageCompat>
): ReturnType<typeof buildHelpMessageCompat> {
  return buildHelpMessageCompat(...args);
}
