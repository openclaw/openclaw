import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const matrixSecrets = loadBundledChannelSecretContractApi("matrix");
if (!matrixSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Matrix secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "matrix"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "matrix"
      ? {
          collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));
