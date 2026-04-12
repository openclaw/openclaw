import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const nextcloudTalkSecrets = loadBundledChannelSecretContractApi("nextcloud-talk");
if (!nextcloudTalkSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Nextcloud Talk secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "nextcloud-talk"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: nextcloudTalkSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "nextcloud-talk"
      ? {
          collectRuntimeConfigAssignments: nextcloudTalkSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));
