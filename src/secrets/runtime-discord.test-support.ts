import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const discordSecrets = loadBundledChannelSecretContractApi("discord");
if (!discordSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Discord secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "discord"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: discordSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "discord"
      ? {
          collectRuntimeConfigAssignments: discordSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));
