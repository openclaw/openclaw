import type { OpenClawConfig } from "../config/config.js";
import { normalizeOptionalAccountId } from "../routing/session-key.js";
import {
  discoverConfigSecretTargetsByIds,
  listSecretTargetRegistryEntries,
} from "../secrets/target-registry.js";

function idsByPrefix(prefixes: readonly string[]): string[] {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
    .toSorted();
}

function idsByPredicate(predicate: (id: string) => boolean): string[] {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter(predicate)
    .toSorted();
}

const WEB_PLUGIN_SECRET_TARGETS = idsByPredicate((id) =>
  /^plugins\.entries\.[^.]+\.config\.(webSearch|webFetch)\.apiKey$/.test(id),
);

const COMMAND_SECRET_TARGETS = {
  qrRemote: ["gateway.remote.token", "gateway.remote.password"],
  channels: idsByPrefix(["channels."]),
  models: idsByPrefix(["models.providers."]),
  agentRuntime: idsByPrefix([
    "channels.",
    "models.providers.",
    "agents.defaults.memorySearch.remote.",
    "agents.list[].memorySearch.remote.",
    "skills.entries.",
    "messages.tts.",
    "tools.web.search",
  ]).concat(WEB_PLUGIN_SECRET_TARGETS),
  status: idsByPrefix([
    "channels.",
    "agents.defaults.memorySearch.remote.",
    "agents.list[].memorySearch.remote.",
  ]),
  securityAudit: idsByPrefix(["channels.", "gateway.auth.", "gateway.remote."]),
} as const;

function toTargetIdSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function normalizeScopedChannelId(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function selectChannelTargetIds(channel?: string): Set<string> {
  if (!channel) {
    return toTargetIdSet(COMMAND_SECRET_TARGETS.channels);
  }
  return toTargetIdSet(
    COMMAND_SECRET_TARGETS.channels.filter((id) => id.startsWith(`channels.${channel}.`)),
  );
}

function pathTargetsScopedChannelAccount(params: {
  pathSegments: readonly string[];
  channel: string;
  accountId: string;
}): boolean {
  const [root, channelId, accountRoot, accountId] = params.pathSegments;
  if (root !== "channels" || channelId !== params.channel) {
    return false;
  }
  if (accountRoot !== "accounts") {
    return true;
  }
  return accountId === params.accountId;
}

export function getScopedChannelsCommandSecretTargets(params: {
  config: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
} {
  const channel = normalizeScopedChannelId(params.channel);
  const targetIds = selectChannelTargetIds(channel);
  const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
  if (!channel || !normalizedAccountId) {
    return { targetIds };
  }

  const allowedPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(params.config, targetIds)) {
    if (
      pathTargetsScopedChannelAccount({
        pathSegments: target.pathSegments,
        channel,
        accountId: normalizedAccountId,
      })
    ) {
      allowedPaths.add(target.path);
    }
  }
  return { targetIds, allowedPaths };
}

export function getQrRemoteCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.qrRemote);
}

export function getChannelsCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.channels);
}

export function getModelsCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.models);
}

export function getAgentRuntimeCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.agentRuntime);
}

export function getStatusCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.status);
}

export function getSecurityAuditCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.securityAudit);
}
