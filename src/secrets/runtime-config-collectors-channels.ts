import { getBundledChannelContractSurfaces } from "../channels/plugins/contract-surfaces.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelRecord,
  getChannelSurface,
  isBaseFieldActiveForChannelSurface,
  type ChannelAccountEntry,
} from "./channel-secret-collector-runtime.js";
import {
  isEnabledFlag,
  collectSecretInputAssignment,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type ChannelRuntimeConfigCollectorSurface = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
};

function listChannelRuntimeConfigCollectorSurfaces(): ChannelRuntimeConfigCollectorSurface[] {
  return getBundledChannelContractSurfaces() as ChannelRuntimeConfigCollectorSurface[];
}

function collectIrcAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "irc");
  if (!resolved) {
    return;
  }
  const { channel: irc, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "irc",
    field: "password",
    channel: irc,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level IRC password.",
    accountInactiveReason: "IRC account is disabled.",
  });
  collectNestedChannelFieldAssignments({
    channelKey: "irc",
    nestedKey: "nickserv",
    field: "password",
    channel: irc,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "nickserv") &&
      isRecord(irc.nickserv) &&
      isEnabledFlag(irc.nickserv),
    topInactiveReason:
      "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.nickserv) && isEnabledFlag(account.nickserv),
    accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
  });
}

function collectBlueBubblesAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "bluebubbles");
  if (!resolved) {
    return;
  }
  const { channel: bluebubbles, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "bluebubbles",
    field: "password",
    channel: bluebubbles,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
    accountInactiveReason: "BlueBubbles account is disabled.",
  });
}

function collectMSTeamsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const msteams = getChannelRecord(params.config, "msteams");
  if (!msteams) {
    return;
  }
  collectSecretInputAssignment({
    value: msteams.appPassword,
    path: "channels.msteams.appPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: msteams.enabled !== false,
    inactiveReason: "Microsoft Teams channel is disabled.",
    apply: (value) => {
      msteams.appPassword = value;
    },
  });
}

function collectNextcloudTalkAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "nextcloud-talk");
  if (!resolved) {
    return;
  }
  const { channel: nextcloudTalk, surface } = resolved;
  const inheritsField =
    (field: string) =>
    ({ account, enabled }: ChannelAccountEntry) =>
      enabled && !hasOwnProperty(account, field);
  collectConditionalChannelFieldAssignments({
    channelKey: "nextcloud-talk",
    field: "botSecret",
    channel: nextcloudTalk,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("botSecret"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
    accountInactiveReason: "Nextcloud Talk account is disabled.",
  });
  collectConditionalChannelFieldAssignments({
    channelKey: "nextcloud-talk",
    field: "apiPassword",
    channel: nextcloudTalk,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("apiPassword"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
    accountInactiveReason: "Nextcloud Talk account is disabled.",
  });
}

export function collectChannelConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  collectIrcAssignments(params);
  collectBlueBubblesAssignments(params);
  collectMSTeamsAssignments(params);
  collectNextcloudTalkAssignments(params);
  for (const surface of listChannelRuntimeConfigCollectorSurfaces()) {
    surface.collectRuntimeConfigAssignments?.(params);
  }
}
