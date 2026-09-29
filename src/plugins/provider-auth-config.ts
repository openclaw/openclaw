import { expectDefined } from "@openclaw/normalization-core";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
} from "../config/io.invalid-config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyMergePatch, createMergePatch, mergePatchConflicts } from "../config/merge-patch.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { ProviderAuthConfigApplyError } from "../shared/provider-auth-result.js";
import { transformConfigWithPendingPluginInstalls } from "./install-record-commit.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

const patchOptions = { mergeObjectArraysById: true };

export function createProviderAuthConfigPatch(base: OpenClawConfig, next: OpenClawConfig) {
  return createMergePatch(
    applyProviderAuthConfigPatch(base, {}),
    applyProviderAuthConfigPatch(next, {}),
    patchOptions,
  );
}

/** Replay completed provider setup against current authored settings, without replaying login. */
export async function writeProviderAuthConfig(params: {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  configPatch: unknown;
  credentialsSaved: boolean;
  finalizeConfig?: (next: OpenClawConfig, current: OpenClawConfig) => OpenClawConfig;
  beforeCommit?: () => void;
  writeOptions?: ConfigWriteOptions;
}): Promise<OpenClawConfig> {
  const loginConfig = applyProviderAuthConfigPatch(params.config, {});
  const sourceConfig = applyProviderAuthConfigPatch(params.configSnapshot.sourceConfig, {});
  const runtimeConfig = applyProviderAuthConfigPatch(params.configSnapshot.runtimeConfig, {});
  try {
    const written = await transformConfigWithPendingPluginInstalls({
      base: "source",
      writeOptions: { ...params.writeOptions, beforeCommit: params.beforeCommit },
      transform: (current, { snapshot }) => {
        if (!snapshot.valid) {
          throw createInvalidConfigError(
            snapshot.path,
            formatInvalidConfigDetails(snapshot.issues),
          );
        }
        params.beforeCommit?.();
        let next = applyProviderAuthConfigPatch(current, {});
        if (params.configPatch) {
          if (
            (mergePatchConflicts(loginConfig, runtimeConfig, params.configPatch, patchOptions) &&
              mergePatchConflicts(loginConfig, sourceConfig, params.configPatch, patchOptions)) ||
            mergePatchConflicts(sourceConfig, next, params.configPatch, patchOptions)
          ) {
            throw new Error(
              "Provider settings changed during sign-in. Review the current settings and retry.",
            );
          }
          // SAFETY: The patch derives from typed config; the config owner validates it before writing.
          next = applyMergePatch(next, params.configPatch, patchOptions) as OpenClawConfig;
        }
        next = params.finalizeConfig ? params.finalizeConfig(next, current) : next;
        return { nextConfig: next, result: next };
      },
    });
    return expectDefined(written.result, "provider config mutation result");
  } catch (error) {
    if (!params.credentialsSaved) {
      throw error;
    }
    throw new ProviderAuthConfigApplyError(error);
  }
}
