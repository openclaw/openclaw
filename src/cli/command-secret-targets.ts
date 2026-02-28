const COMMAND_SECRET_TARGETS = {
  memory: [
    "agents.defaults.memorySearch.remote.apiKey",
    "agents.list[].memorySearch.remote.apiKey",
  ],
  qrRemote: ["gateway.remote.token", "gateway.remote.password"],
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
