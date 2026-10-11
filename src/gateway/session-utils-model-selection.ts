import { readSessionRuntimeOwnership } from "../agents/harness/session-runtime-ownership.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import { resolveSessionConfiguredDefault } from "../agents/session-model-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveStoredModelOverrideCore,
  type StoredModelOverride,
} from "../sessions/stored-model-overrides.js";
import type {
  GatewaySessionModelSource,
  SessionListRowContext,
} from "./session-utils-contracts.js";

export function resolveSessionSelectedModelRef(
  params: {
    cfg: OpenClawConfig;
    source: GatewaySessionModelSource;
    agentId: string;
    sessionKey?: string;
    rowContext?: Pick<SessionListRowContext, "configuredDefaultModelByAgent">;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ReturnType<typeof resolveSessionConfiguredDefault> & {
  storedOverrideSource: StoredModelOverride["source"] | null;
} {
  // Native ownership remains session-specific even when configured defaults are shared.
  const ownership = readSessionRuntimeOwnership({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.source.entry,
  });
  if (ownership?.modelRef) {
    return { ...ownership.modelRef, storedOverrideSource: null };
  }
  const configuredDefault = resolveSessionConfiguredDefault(params.cfg, params.agentId, {
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
    configuredDefaultModelByAgent: params.rowContext?.configuredDefaultModelByAgent,
  });
  const storedOverride = resolveStoredModelOverrideCore({
    // A prepared miss is authoritative; the presentation store can contain another owner's alias.
    loadSessionEntry: params.source.readSourceEntry,
    sessionEntry: params.source.entry,
    sessionKey: params.sessionKey,
    parentSessionKey: params.source.entry?.parentSessionKey,
    defaultProvider: configuredDefault.provider,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  if (!storedOverride) {
    return { ...configuredDefault, storedOverrideSource: null };
  }
  return {
    provider: storedOverride.provider ?? configuredDefault.provider,
    model: storedOverride.model,
    storedOverrideSource: storedOverride.source,
  };
}
