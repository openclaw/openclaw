// Doctor retains preimage ownership until its config/state repair commits. Runtime ignores it.
const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();

export function setRetainedLegacyDefaultAgentId(config: object, agentId: string | undefined): void {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, agentId);
  } else {
    legacyDefaultAgentIdByConfig.delete(config);
  }
}

export function getRetainedLegacyDefaultAgentId(config: object): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}
