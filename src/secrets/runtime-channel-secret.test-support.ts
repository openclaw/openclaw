import { loadChannelSecretContractApi } from "./channel-contract-api.js";

export function createRuntimeChannelSecretRegistry(channelId: string, channelName: string) {
  const secrets = loadChannelSecretContractApi({ channelId, config: {} });
  if (!secrets?.collectRuntimeConfigAssignments) {
    throw new Error(`Missing ${channelName} secret contract api`);
  }
  const collectRuntimeConfigAssignments = secrets.collectRuntimeConfigAssignments;

  return {
    getBootstrapChannelPlugin: (id: string) =>
      id === channelId ? { secrets: { collectRuntimeConfigAssignments } } : undefined,
    getBootstrapChannelSecrets: (id: string) =>
      id === channelId ? { collectRuntimeConfigAssignments } : undefined,
  };
}
