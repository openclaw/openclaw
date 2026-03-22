import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
  saveSessionStore,
} from "../../config/sessions.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeAgent(): PluginRuntime["agent"] {
  return {
    defaults: {
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault,
    runEmbeddedPiAgent,
    resolveAgentTimeoutMs,
    ensureAgentWorkspace,
    abort() {
      throw new Error("Plugin runtime agent.abort is only available during a gateway request.");
    },
    session: {
      resolveStorePath,
      loadSessionStore,
      saveSessionStore,
      resolveSessionFilePath,
    },
  };
}
