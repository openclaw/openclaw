import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export function createDoctorModelRefResolver(cfg: OpenClawConfig) {
  const resolvers = new Map<string | undefined, (raw: string) => string | undefined>();
  return (raw: string, agentId?: string): string | undefined => {
    let resolve = resolvers.get(agentId);
    if (!resolve) {
      const options = {
        cfg,
        agentId,
        allowPluginNormalization: false,
        allowManifestNormalization: false,
      };
      const defaultProvider = resolveConfiguredModelRef({
        ...options,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }).provider;
      const aliasIndex = buildModelAliasIndex({ ...options, defaultProvider });
      resolve = (value) => {
        const ref = resolveModelRefFromString({
          ...options,
          raw: splitTrailingAuthProfile(value).model,
          defaultProvider,
          aliasIndex,
        })?.ref;
        return ref ? ref.provider + "/" + ref.model : undefined;
      };
      resolvers.set(agentId, resolve);
    }
    return resolve(raw);
  };
}
