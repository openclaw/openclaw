import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolverContext } from "./runtime-shared.js";

const getBootstrapChannelSecrets = vi.fn();
const loadBundledChannelSecretContractApi = vi.fn();

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelSecrets,
}));

vi.mock("./channel-contract-api.js", () => ({
  loadBundledChannelSecretContractApi,
}));

describe("runtime channel config collectors", () => {
  beforeEach(() => {
    getBootstrapChannelSecrets.mockReset();
    loadBundledChannelSecretContractApi.mockReset();
  });

  it("uses the bundled channel contract-api collector when bootstrap secrets are unavailable", async () => {
    const { collectChannelConfigAssignments } =
      await import("./runtime-config-collectors-channels.js");
    const collectRuntimeConfigAssignments = vi.fn();
    loadBundledChannelSecretContractApi.mockReturnValue({
      collectRuntimeConfigAssignments,
    });
    getBootstrapChannelSecrets.mockReturnValue(undefined);

    collectChannelConfigAssignments({
      config: {
        channels: {
          bluebubbles: {
            accounts: {
              ops: {},
            },
          },
        },
      } as OpenClawConfig,
      defaults: undefined,
      context: {} as ResolverContext,
    });

    expect(loadBundledChannelSecretContractApi).toHaveBeenCalledWith("bluebubbles");
    expect(collectRuntimeConfigAssignments).toHaveBeenCalledOnce();
    expect(getBootstrapChannelSecrets).not.toHaveBeenCalled();
  });

  it("falls back to bootstrap secrets when no channel contract-api is published", async () => {
    const { collectChannelConfigAssignments } =
      await import("./runtime-config-collectors-channels.js");
    const collectRuntimeConfigAssignments = vi.fn();
    loadBundledChannelSecretContractApi.mockReturnValue(undefined);
    getBootstrapChannelSecrets.mockReturnValue({
      collectRuntimeConfigAssignments,
    });

    collectChannelConfigAssignments({
      config: {
        channels: {
          legacy: {},
        },
      } as OpenClawConfig,
      defaults: undefined,
      context: {} as ResolverContext,
    });

    expect(loadBundledChannelSecretContractApi).toHaveBeenCalledWith("legacy");
    expect(getBootstrapChannelSecrets).toHaveBeenCalledWith("legacy");
    expect(collectRuntimeConfigAssignments).toHaveBeenCalledOnce();
  });
});
