import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type RuntimeSelection = {
  agentId: string;
  provider: string;
  model: string;
  entry?: SessionEntry;
};

function selectionKey(params: RuntimeSelection) {
  return [
    params.agentId,
    params.provider,
    params.model,
    params.entry?.agentHarnessId,
    params.entry?.agentRuntimeOverride,
    params.entry?.modelSelectionLocked,
    params.entry?.pluginOwnerId,
  ];
}

/** Prepared agent scopes make keys session-independent; the next selection rechecks live harnesses. */
export function createSessionRuntimeResolution(cfg: OpenClawConfig) {
  const metadata = new Map<string, ReturnType<typeof resolveCurrentSessionAgentRuntimeMetadata>>();
  const effective = new Map<string, string>();
  return {
    metadata(params: RuntimeSelection & { preparedAcpMeta?: SessionEntry["acp"] | null }) {
      const acp = params.preparedAcpMeta;
      const key = JSON.stringify([...selectionKey(params), acp != null, acp?.backend]);
      let value = metadata.get(key);
      if (!value) {
        value = resolveCurrentSessionAgentRuntimeMetadata({
          cfg,
          agentScope: { kind: "prepared", agentId: params.agentId },
          provider: params.provider,
          model: params.model,
          sessionEntry: params.entry,
          acpRuntime: acp != null,
          acpBackend: acp?.backend,
        });
        metadata.set(key, value);
      }
      return value;
    },
    effective(params: RuntimeSelection, route?: { api?: string; baseUrl?: unknown }) {
      const modelBaseUrl = normalizeOptionalString(route?.baseUrl);
      const key = JSON.stringify([...selectionKey(params), route?.api, modelBaseUrl]);
      let value = effective.get(key);
      if (value === undefined) {
        value = resolveEffectiveAgentRuntime({
          cfg,
          agentScope: { kind: "prepared", agentId: params.agentId },
          provider: params.provider,
          modelId: params.model,
          sessionEntry: params.entry,
          modelApi: route?.api,
          modelBaseUrl,
        });
        effective.set(key, value);
      }
      return value;
    },
  };
}

export type SessionRuntimeResolution = ReturnType<typeof createSessionRuntimeResolution>;
