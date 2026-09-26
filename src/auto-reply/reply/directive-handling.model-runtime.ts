/** Resolves and applies explicit runtime selections attached to `/model`. */
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ModelRuntimeDirectiveResolution =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string; errorText: string };

/** Preserves compatible runtime pins and validates explicit runtime selections. */
export function resolveModelRuntimeDirective(params: {
  rawRuntime?: string;
  provider: string;
  cfg: OpenClawConfig;
  sessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): ModelRuntimeDirectiveResolution {
  const requestedRuntime = params.rawRuntime?.trim();
  const rawRuntime = requestedRuntime || params.sessionEntry?.agentRuntimeOverride?.trim();
  if (!rawRuntime) {
    return { kind: "unchanged" };
  }

  const runtime = normalizeOptionalAgentRuntimeId(rawRuntime);
  if (isDefaultAgentRuntimeId(runtime)) {
    return { kind: requestedRuntime ? "clear" : "unchanged" };
  }

  const provider = normalizeProviderId(params.provider);
  const compatibleRuntime = resolveCompatibleAgentRuntimeForProvider({
    provider,
    runtime,
    cfg: params.cfg,
  });
  if (compatibleRuntime) {
    return requestedRuntime ? { kind: "set", runtime: compatibleRuntime } : { kind: "unchanged" };
  }

  if (!requestedRuntime) {
    // A pin from the previous provider must not block the selected model's configured route.
    return { kind: "clear" };
  }

  return {
    kind: "invalid",
    runtime: rawRuntime,
    errorText: `Runtime "${rawRuntime}" is not supported for ${provider || params.provider}.`,
  };
}

/** Applies a validated runtime choice, clearing consent with an incompatible or reset pin. */
export function applyModelRuntimeDirective(
  entry: Pick<SessionEntry, "agentRuntimeOverride" | "nativeRuntimeConsent">,
  resolution: ModelRuntimeDirectiveResolution,
): { updated: boolean } {
  if (resolution.kind === "clear") {
    const updated =
      entry.agentRuntimeOverride !== undefined || entry.nativeRuntimeConsent !== undefined;
    delete entry.agentRuntimeOverride;
    delete entry.nativeRuntimeConsent;
    return { updated };
  }
  if (resolution.kind === "set") {
    const updated =
      entry.agentRuntimeOverride !== resolution.runtime ||
      (entry.nativeRuntimeConsent !== undefined &&
        entry.nativeRuntimeConsent !== resolution.runtime);
    if (updated) {
      delete entry.nativeRuntimeConsent;
    }
    entry.agentRuntimeOverride = resolution.runtime;
    return { updated };
  }
  return { updated: false };
}
