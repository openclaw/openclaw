/** Runtime SDK subpath for model overrides and agent concurrency session helpers. */
import {
  findPersistedAuthProfileCredential,
  getRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/store.js";
import {
  applySessionModelSelectionInternal,
  type ApplySessionModelSelectionParams,
  type ApplySessionModelSelectionResult,
} from "../model-picker/apply-session-model-selection.js";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import {
  applyModelOverrideWithAuthProfileCompatibilityCore as applyPreparedModelOverride,
  applyModelOverrideWithAuthProfileCompatibilityAsync,
} from "../sessions/auth-profile-preservation.js";

export { resolveChannelModelOverride } from "../channels/model-overrides.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
export { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
export { resolveSessionModelRef } from "../agents/session-model-ref.js";
export const applySessionModelSelection: (
  params: ApplySessionModelSelectionParams,
) => Promise<ApplySessionModelSelectionResult> = (params) =>
  applySessionModelSelectionInternal({
    ...params,
    ...(params.validateAuthProfileSelection ? { nativeCommitValidation: true } : {}),
  });
export type {
  ApplySessionModelSelectionParams,
  ApplySessionModelSelectionResult,
  SessionModelSelectionRequest,
} from "../model-picker/apply-session-model-selection.js";
export {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../sessions/model-overrides.js";
export { applyModelOverrideWithAuthProfileCompatibilityAsync };

/** @deprecated Await applyModelOverrideWithAuthProfileCompatibilityAsync; removed in a later release after stable deprecation. */
export function applyModelOverrideWithAuthProfileCompatibility(
  params: Parameters<typeof applyModelOverrideWithAuthProfileCompatibilityAsync>[0],
): { updated: boolean } {
  warnPluginSdkDeprecation({
    family: "model-session",
    method: "applyModelOverrideWithAuthProfileCompatibility",
    replacement: "applyModelOverrideWithAuthProfileCompatibilityAsync",
  });
  const metadataSnapshot =
    params.metadataSnapshot ??
    loadLegacyPluginMetadataSnapshotRuntime({
      config: params.cfg,
      allowWorkspaceScopedCurrent: true,
    });
  const profileId = params.entry.authProfileOverride?.trim();
  const recordedProvider =
    params.recordedProvider ??
    (profileId && !params.profileOverride
      ? {
          provider:
            getRuntimeAuthProfileStoreSnapshot(params.agentDir)?.profiles[profileId]?.provider ??
            findPersistedAuthProfileCredential({ agentDir: params.agentDir, profileId })?.provider,
        }
      : { provider: undefined });
  return applyPreparedModelOverride({ ...params, metadataSnapshot, recordedProvider });
}
