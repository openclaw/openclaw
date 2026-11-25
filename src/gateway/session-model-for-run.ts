import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveSessionSelectedModelRefAsync } from "./session-utils-model-selection.js";
import { prepareGatewaySessionEntryReader } from "./session-utils-store-lineage.js";

/** Prepare the session's selected model (including its parent's pick) before leasing a runtime. */
export async function resolveGatewaySessionModelForRun(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    entry?: SessionEntry;
    abortSignal?: AbortSignal;
  } & ModelManifestNormalizationContext,
) {
  const { cfg, agentId, sessionKey, entry, abortSignal } = params;
  const readSourceEntry = await prepareGatewaySessionEntryReader({
    cfg,
    agentId,
    sessionKey,
    entry,
    store: {},
  });
  abortSignal?.throwIfAborted();
  return resolveSessionSelectedModelRefAsync({
    cfg,
    agentId,
    sessionKey,
    source: { entry, readSourceEntry },
    manifestPlugins: params.manifestPlugins ?? getGatewayPluginMetadataSnapshot() ?? [],
  });
}
