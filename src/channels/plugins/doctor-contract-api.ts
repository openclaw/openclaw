import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
import { loadOptionalBundledChannelPublicArtifact } from "./optional-public-artifact.js";

/**
 * Config returned after a bundled channel normalizes legacy compatibility state.
 */
type BundledChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

/**
 * Public doctor hooks exported by bundled channel plugins.
 *
 * Doctor keeps these hooks channel-owned so core can run config repair without
 * importing plugin internals.
 */
type BundledChannelDoctorContractApi = {
  legacyConfigRules?: readonly LegacyConfigRule[];
  normalizeCompatibilityConfig?: (params: {
    cfg: OpenClawConfig;
  }) => BundledChannelDoctorCompatibilityMutation;
};

/**
 * Loads a bundled channel's public doctor contract.
 */
export function loadBundledChannelDoctorContractApi(
  channelId: string,
): BundledChannelDoctorContractApi | undefined {
  return loadOptionalBundledChannelPublicArtifact<BundledChannelDoctorContractApi>({
    channelId,
    artifactBasename: "doctor-contract-api.js",
  });
}
