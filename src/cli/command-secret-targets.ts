import { listSecretTargetRegistryEntries } from "../secrets/target-registry.js";

function idsByPrefix(prefixes: readonly string[]): string[] {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
    .toSorted();
}

const COMMAND_SECRET_TARGETS = {
  memory: [
    "agents.defaults.memorySearch.remote.apiKey",
    "agents.list[].memorySearch.remote.apiKey",
  ],
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
    "tools.web.fetch.firecrawl.",
  ]),
  status: [
    ...idsByPrefix([
      "channels.",
      "agents.defaults.memorySearch.remote.",
      "agents.list[].memorySearch.remote.",
    ]),
    "gateway.auth.token",
    "gateway.auth.password",
  ],
} as const;

function toTargetIdSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

export function getMemoryCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(COMMAND_SECRET_TARGETS.memory);
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
