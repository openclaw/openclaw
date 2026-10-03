import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";

type ContextEngineRuntimeQuarantineForTests = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryStateForTests = {
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantineForTests>;
};

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

function getContextEngineRegistryStateForTests(): ContextEngineRegistryStateForTests {
  return resolveGlobalSingleton<ContextEngineRegistryStateForTests>(
    CONTEXT_ENGINE_REGISTRY_STATE,
    () => ({ quarantinedEngines: new Map() }),
  );
}

// An abandoned overlapping clear must not restore its quarantine into the next test.
function clearPendingQuarantineClearsForTests(): void {
  resolveGlobalSingleton<Map<string, unknown>>(
    Symbol.for("openclaw.contextEngineQuarantineClears"),
    () => new Map(),
  ).clear();
}

export function captureContextEngineRegistryStateForTests(): () => Promise<void> {
  const state = getContextEngineRegistryStateForTests();
  const registry = requireActivePluginRegistry();
  const engines = new Map(registry.contextEngines);
  const quarantinedEngines = new Map(state.quarantinedEngines);

  return async () => {
    registry.contextEngines.clear();
    for (const [engineId, registration] of engines) {
      registry.contextEngines.set(engineId, registration as never);
    }

    state.quarantinedEngines.clear();
    clearPendingQuarantineClearsForTests();
    await clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
    for (const [engineId, quarantine] of quarantinedEngines) {
      state.quarantinedEngines.set(engineId, quarantine);
      await recordPersistedContextEngineQuarantine(quarantine);
    }
  };
}

export async function resetContextEngineRuntimeQuarantineForTests(): Promise<void> {
  const state = getContextEngineRegistryStateForTests();
  state.quarantinedEngines.clear();
  clearPendingQuarantineClearsForTests();
  await clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
}
