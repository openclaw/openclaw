import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveModelContextTokenProjection } from "../agents/context.js";
import { resolveAutoAgentHarnessId } from "../agents/harness/support.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

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

export function resolveSessionProjectedAutoRuntime(
  params: Pick<RuntimeSelection, "agentId" | "provider" | "model"> & {
    cfg: OpenClawConfig;
    sessionKey?: string;
  },
): string {
  return (
    resolveAutoAgentHarnessId({
      config: params.cfg,
      agentScope: { kind: "prepared", agentId: params.agentId },
      provider: params.provider,
      modelId: params.model,
      sessionKey: params.sessionKey,
    }) ?? "openclaw"
  );
}

/** Share model-route decisions within a projection batch. */
export function createSessionRuntimeResolution(cfg: OpenClawConfig) {
  const metadata = new Map<string, ReturnType<typeof resolveCurrentSessionAgentRuntimeMetadata>>();
  const effective = new Map<string, string>();
  const placement = new Map<string, ReturnType<typeof projectWorkerPlacementAgentRuntime>>();
  const contexts = new Map<string, ReturnType<typeof resolveModelContextTokenProjection>>();
  return {
    placement(this: void, runtime: Parameters<typeof projectWorkerPlacementAgentRuntime>[0]) {
      const key = JSON.stringify(runtime);
      let value = placement.get(key);
      if (!value) {
        value = projectWorkerPlacementAgentRuntime(runtime);
        placement.set(key, value);
      }
      return value;
    },
    context(
      this: void,
      params: Pick<
        Parameters<typeof resolveModelContextTokenProjection>[0],
        "provider" | "model" | "modelContextTokens" | "modelContextWindow"
      >,
    ) {
      const key = JSON.stringify([
        params.provider,
        params.model,
        params.modelContextTokens,
        params.modelContextWindow,
      ]);
      let value = contexts.get(key);
      if (!value) {
        value = resolveModelContextTokenProjection({
          ...params,
          cfg,
          allowAsyncLoad: false,
          allowCacheLookup: false,
        });
        contexts.set(key, value);
      }
      return value;
    },
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
    effective(
      params: RuntimeSelection,
      route?: { api?: string; baseUrl?: unknown },
      preparedAutoRuntime?: string,
    ) {
      const modelBaseUrl = normalizeOptionalString(route?.baseUrl);
      const key = JSON.stringify([...selectionKey(params), route?.api, modelBaseUrl]);
      let value = effective.get(key);
      if (value === undefined) {
        // Without a catalog route the caller has already resolved the policy to auto.
        value = route
          ? resolveEffectiveAgentRuntime({
              cfg,
              agentScope: { kind: "prepared", agentId: params.agentId },
              provider: params.provider,
              modelId: params.model,
              sessionEntry: params.entry,
              modelApi: route.api,
              modelBaseUrl,
              preparedAutoRuntime,
            })
          : resolveSessionProjectedAutoRuntime({ ...params, cfg });
        effective.set(key, value);
      }
      return value;
    },
  };
}

export type SessionRuntimeResolution = ReturnType<typeof createSessionRuntimeResolution>;
