/** Resolves and applies explicit runtime selections attached to `/model`. */
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import { resolveCliRuntimeModelBackendBinding } from "../../agents/cli-backends.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type ModelRuntimeDirectiveResolution =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string; errorText: string };

/** Validates a requested runtime against the provider selected by the same directive. */
export function resolveModelRuntimeDirective(params: {
  rawRuntime?: string;
  provider: string;
  cfg: OpenClawConfig;
  sessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): ModelRuntimeDirectiveResolution {
  const rawRuntime = params.rawRuntime?.trim();
  if (!rawRuntime) {
    const persistedRuntime = params.sessionEntry?.agentRuntimeOverride?.trim();
    if (
      persistedRuntime &&
      !resolveSessionRuntimeOverrideForProvider({
        provider: params.provider,
        entry: params.sessionEntry,
        cfg: params.cfg,
      })
    ) {
      return { kind: "clear" };
    }
    return { kind: "unchanged" };
  }

  const runtime = normalizeOptionalAgentRuntimeId(rawRuntime);
  if (isDefaultAgentRuntimeId(runtime)) {
    return { kind: "clear" };
  }
  if (runtime === "openclaw") {
    return { kind: "set", runtime };
  }

  const provider = normalizeProviderId(params.provider);
  if (provider === "openai" && runtime === "codex") {
    return { kind: "set", runtime };
  }
  const backend = resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime,
  });
  if (backend) {
    return { kind: "set", runtime: backend.runtime };
  }

  return {
    kind: "invalid",
    runtime: rawRuntime,
    errorText: `Runtime "${rawRuntime}" is not supported for ${provider || params.provider}.`,
  };
}

/** Applies a validated runtime choice without disturbing existing pins when no choice was given. */
export function applyModelRuntimeDirective(
  entry: Pick<SessionEntry, "agentRuntimeOverride">,
  resolution: ModelRuntimeDirectiveResolution,
): { updated: boolean } {
  if (resolution.kind === "clear") {
    const updated = entry.agentRuntimeOverride !== undefined;
    delete entry.agentRuntimeOverride;
    return { updated };
  }
  if (resolution.kind === "set") {
    const updated = entry.agentRuntimeOverride !== resolution.runtime;
    entry.agentRuntimeOverride = resolution.runtime;
    return { updated };
  }
  return { updated: false };
}
