/** Resolves and applies explicit runtime selections attached to `/model`. */
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { isAppServerRuntimeModelBackendBinding } from "../../agents/app-server-runtime-bindings.js";
import { resolveAgentHarnessOwnerPluginIds } from "../../agents/harness/runtime-plugin.js";
import { isCliRuntimeAliasForProvider } from "../../agents/model-runtime-aliases.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../../agents/session-runtime-compat.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace-default.js";
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
  agentId?: string;
  workspaceDir?: string;
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
    if (!requestedRuntime) {
      return { kind: "unchanged" };
    }
    const unavailableText = resolveUnavailableHarnessOwnerText({
      runtime: compatibleRuntime,
      rawRuntime,
      provider,
      cfg: params.cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
    return unavailableText
      ? { kind: "invalid", runtime: rawRuntime, errorText: unavailableText }
      : { kind: "set", runtime: compatibleRuntime };
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

/**
 * App-server harness bindings are a static provider/runtime table, so a
 * compatible runtime is not necessarily an *available* one: its owning plugin
 * can be disabled or outside `plugins.allow`. Accepting it here would persist an
 * override that reports success and then dead-ends the next turn in
 * `ensureSelectedAgentHarnessPlugin`, so this mirrors that function's own
 * exemptions (the built-in runtime and CLI backends, which own their own
 * availability) and otherwise requires an enabled owner — the same signal the
 * `/models` runtime chooser filters its offers with.
 */
function resolveUnavailableHarnessOwnerText(params: {
  runtime: string;
  rawRuntime: string;
  provider: string;
  cfg: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): string | undefined {
  if (params.runtime === OPENCLAW_AGENT_RUNTIME_ID) {
    return undefined;
  }
  // App-server harness bindings are the non-CLI parallel of the CLI runtime
  // bindings, so a pair served by one is never served by the other. Answering
  // from the static table first keeps the CLI-backend probe -- which falls
  // through to synchronous plugin setup discovery once a config is supplied --
  // off the native `/model` fast path, which forbids it and which `main` never
  // reached here because it accepted a compatible runtime unconditionally.
  const appServerBound = isAppServerRuntimeModelBackendBinding({
    provider: params.provider,
    runtime: params.runtime,
  });
  if (
    !appServerBound &&
    isCliRuntimeAliasForProvider({
      provider: params.provider,
      runtime: params.runtime,
      cfg: params.cfg,
    })
  ) {
    return undefined;
  }
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined) ??
    resolveDefaultAgentWorkspaceDir();
  const ownerPluginIds = resolveAgentHarnessOwnerPluginIds({
    runtime: params.runtime,
    provider: params.provider,
    config: params.cfg,
    workspaceDir,
  });
  return ownerPluginIds.length > 0
    ? undefined
    : `Runtime "${params.rawRuntime}" is unavailable: no enabled plugin owns agent harness "${params.runtime}". Enable that plugin, restart the Gateway, then retry, or use /models to pick an available runtime.`;
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
