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
  // Ask the agent-harness owner FIRST. `resolveAgentHarnessOwnerPluginIds()`
  // reads the manifest activation plan only, so it answers every app-server
  // harness -- the fixed-table ones and the dynamically-routed ones such as
  // acpx's `acp-opencode` -- without touching the CLI setup registry. That
  // matters because the CLI-backend probe falls through to SYNCHRONOUS plugin
  // setup discovery once a config is supplied, which the native `/model` fast
  // path forbids (`main` never reached here at all: it accepted a compatible
  // runtime unconditionally). Gating the probe on the fixed binding table alone
  // left dynamic harnesses -- absent from that table but compatible via
  // manifest discovery -- falling into it and throwing.
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
  if (ownerPluginIds.length > 0) {
    return undefined;
  }
  // No enabled agent-harness owner. A CLI backend owns its own availability, so
  // it is still available -- but app-server bindings are the non-CLI parallel of
  // the CLI runtime bindings, so a pair served by one is never served by the
  // other and probing for a bound pair would only risk the forbidden discovery.
  if (
    !isAppServerRuntimeModelBackendBinding({
      provider: params.provider,
      runtime: params.runtime,
    }) &&
    isCliRuntimeAliasForProvider({
      provider: params.provider,
      runtime: params.runtime,
      cfg: params.cfg,
    })
  ) {
    return undefined;
  }
  return `Runtime "${params.rawRuntime}" is unavailable: no enabled plugin owns agent harness "${params.runtime}". Enable that plugin, restart the Gateway, then retry, or use /models to pick an available runtime.`;
}

/** Applies a validated runtime choice, clearing consent with an incompatible or reset pin. */
export function applyModelRuntimeDirective(
  entry: Pick<SessionEntry, "agentRuntimeOverride" | "nativeRuntimeConsent">,
  resolution: ModelRuntimeDirectiveResolution,
): { updated: boolean } {
  if (resolution.kind !== "clear" && resolution.kind !== "set") {
    return { updated: false };
  }
  const runtime = resolution.kind === "set" ? resolution.runtime : undefined;
  const updated =
    entry.agentRuntimeOverride !== runtime ||
    (entry.nativeRuntimeConsent !== undefined && entry.nativeRuntimeConsent !== runtime);
  if (resolution.kind === "clear") {
    delete entry.agentRuntimeOverride;
  }
  if (updated || resolution.kind === "clear") {
    delete entry.nativeRuntimeConsent;
  }
  if (resolution.kind === "set") {
    entry.agentRuntimeOverride = resolution.runtime;
  }
  return { updated };
}
