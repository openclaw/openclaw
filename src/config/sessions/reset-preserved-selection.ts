import { resolveAgentRuntimeMetadata } from "../../agents/agent-runtime-metadata.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";

export type ResetPreservedSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

/**
 * Decide which model/provider/auth overrides survive a `/new` or `/reset`.
 *
 * Only user-driven overrides (explicit `/model`, `sessions.patch`, etc.) are
 * preserved. Auto-created overrides (runtime fallbacks, rate-limit rotations)
 * are cleared so resets actually return the session to the configured default.
 *
 * Legacy entries persisted before `modelOverrideSource` was tracked are
 * treated as user-driven, matching the prior reset behavior so explicit
 * selections made before the source field existed are not silently dropped.
 */
function isStaleLegacyOpenAICodexOverride(params: {
  entry: SessionEntry;
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  if (
    !params.cfg ||
    !params.entry.modelOverride ||
    params.entry.modelOverrideSource !== undefined
  ) {
    return false;
  }

  const runtime = resolveAgentRuntimeMetadata(params.cfg, params.agentId ?? "").id;
  if (runtime !== "codex") {
    return false;
  }

  const selected = parseModelRef(params.entry.modelOverride, params.entry.providerOverride ?? "", {
    allowPluginNormalization: false,
  });
  if (!selected || selected.provider !== "openai-codex") {
    return false;
  }

  const configured = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    allowPluginNormalization: false,
  });
  return configured.provider === "openai" && configured.model === selected.model;
}

export function resolveResetPreservedSelection(params: {
  entry?: SessionEntry;
  cfg?: OpenClawConfig;
  agentId?: string;
}): Partial<ResetPreservedSelectionState> {
  const { entry } = params;
  if (!entry) {
    return {};
  }

  const preserved: Partial<ResetPreservedSelectionState> = {};
  const preserveLegacyUserModelOverride =
    entry.modelOverrideSource === "user" ||
    (entry.modelOverrideSource === undefined &&
      Boolean(entry.modelOverride) &&
      !isStaleLegacyOpenAICodexOverride({
        entry,
        cfg: params.cfg,
        agentId: params.agentId,
      }));
  if (preserveLegacyUserModelOverride && entry.modelOverride) {
    preserved.providerOverride = entry.providerOverride;
    preserved.modelOverride = entry.modelOverride;
    preserved.modelOverrideSource = "user";
  }

  if (entry.authProfileOverrideSource === "user" && entry.authProfileOverride) {
    preserved.authProfileOverride = entry.authProfileOverride;
    preserved.authProfileOverrideSource = entry.authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }

  return preserved;
}
