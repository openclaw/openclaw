// Legacy compat surface for plugins that still import openclaw/extension-api.
// Keep this file intentionally narrow and forward-only.

const shouldWarnExtensionApiImport =
  process.env.VITEST !== "true" &&
  process.env.NODE_ENV !== "test" &&
  process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1";

if (shouldWarnExtensionApiImport) {
  process.emitWarning(
    "openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration",
    {
      code: "OPENCLAW_EXTENSION_API_DEPRECATED",
      detail:
        "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration",
    },
  );
}

export { resolveAgentDir, resolveAgentWorkspaceDir } from "./agents/agent-scope.js";
export { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./agents/defaults.js";
export { resolveAgentIdentity } from "./agents/identity.js";
export { resolveThinkingDefault } from "./agents/model-selection.js";
/**
 * @deprecated Use `runAgent` instead. The pi-embedded runtime is
 * scheduled for removal once `claude-sdk` completes its production soak.
 * `runAgent` auto-routes through the active driver via
 * `agents.list[<id>].runtime.type`, and the return shape is stable, so
 * callers migrate by renaming the call site.
 */
export { runEmbeddedPiAgent } from "./agents/pi-embedded.js";
// Preferred agent entry point since the Phase 3 default flip: picks the
// active runtime (claude-sdk by default, pi-embedded for agents that
// still set `runtime.type: "embedded"`, acp for ACP-backed agents) and
// dispatches. Return shape is stable (`RunAgentResult`) regardless of
// which driver handled the call.
export { runAgent } from "./agents/runtime-dispatch.js";
export type { RunAgentParams, RunAgentResult } from "./agents/runtime-dispatch.js";
export { resolveAgentTimeoutMs } from "./agents/timeout.js";
export { ensureAgentWorkspace } from "./agents/workspace.js";
export {
  resolveStorePath,
  loadSessionStore,
  saveSessionStore,
  resolveSessionFilePath,
} from "./config/sessions.js";
