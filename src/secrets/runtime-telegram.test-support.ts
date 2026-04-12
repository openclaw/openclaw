import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const telegramSecrets = loadBundledChannelSecretContractApi("telegram");
if (!telegramSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Telegram secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "telegram"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: telegramSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "telegram"
      ? {
          collectRuntimeConfigAssignments: telegramSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));
