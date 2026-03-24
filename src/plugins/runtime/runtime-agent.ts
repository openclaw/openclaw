import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveSessionFilePath, resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { PluginRuntime } from "./types.js";

function defineCachedValue<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  create: () => unknown,
): void {
  let cached: unknown;
  let ready = false;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      if (!ready) {
        cached = create();
        ready = true;
      }
      return cached;
    },
  });
}

const loadEmbeddedPiRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-pi.runtime.js"),
);

export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: {
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault,
    resolveAgentTimeoutMs,
    ensureAgentWorkspace,
  } satisfies Omit<PluginRuntime["agent"], "runEmbeddedPiAgent" | "session"> &
    Partial<Pick<PluginRuntime["agent"], "runEmbeddedPiAgent" | "session">>;

  defineCachedValue(agentRuntime, "runEmbeddedPiAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedPiRuntime, (runtime) => runtime.runEmbeddedPiAgent),
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath,
    loadSessionStore,
    saveSessionStore,
    resolveSessionFilePath,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
