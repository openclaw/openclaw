// Authoritative process quarantine and its best-effort persistent health mirror.
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearPersistedContextEngineQuarantineForActivation,
  clearPersistedContextEngineQuarantineForProcess,
  listPersistedContextEngineQuarantines,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

type ContextEngineRuntimeQuarantine = Awaited<
  ReturnType<typeof listPersistedContextEngineQuarantines>
>[number];

type ContextEngineRegistryState = {
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantine>;
  // Engines whose persisted mirror may still hold this process's record. Kept
  // apart from quarantinedEngines because a cleared quarantine can still own a
  // row when its persisted clear failed or was superseded; later clears retry it.
  persistedQuarantineEngineIds: Set<string>;
};

// Keep authoritative process quarantine shared across duplicated dist chunks.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    quarantinedEngines: new Map(),
    persistedQuarantineEngineIds: new Set(),
  }),
);

export async function recordContextEngineQuarantine(params: {
  engineId: string;
  owner?: string;
  operation: string;
  error: unknown;
  defaultEngineId: string;
}): Promise<ContextEngineRuntimeQuarantine> {
  const existing = contextEngineRegistryState.quarantinedEngines.get(params.engineId);
  if (existing) {
    // First failure wins so logs and diagnostics point at the root cause, not follow-on fallback use.
    return existing;
  }

  const quarantine: ContextEngineRuntimeQuarantine = {
    engineId: params.engineId,
    operation: params.operation,
    reason: params.error instanceof Error ? params.error.message : String(params.error),
    failedAt: new Date(),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  contextEngineRegistryState.quarantinedEngines.set(params.engineId, quarantine);
  contextEngineRegistryState.persistedQuarantineEngineIds.add(params.engineId);
  try {
    await recordPersistedContextEngineQuarantine(quarantine, () => {
      if (contextEngineRegistryState.quarantinedEngines.get(quarantine.engineId) !== quarantine) {
        throw new Error("Context engine quarantine was cleared");
      }
    });
    // A synchronous activation clear can run after admission but before this
    // write lands and forget the id, so track the landed row again.
    contextEngineRegistryState.persistedQuarantineEngineIds.add(params.engineId);
  } catch {
    // Quarantine behavior must not depend on the best-effort health mirror.
  }
  const ownerSuffix = params.owner ? ` owner=${sanitizeForLog(params.owner)}` : "";
  console.error(
    `[context-engine] Context engine "${sanitizeForLog(params.engineId)}"${ownerSuffix} failed during ${sanitizeForLog(params.operation)}: ` +
      `${sanitizeForLog(quarantine.reason)}; quarantining it for this process and falling back to default engine "${params.defaultEngineId}".`,
  );
  return quarantine;
}

export function getContextEngineQuarantine(
  engineId: string,
): ContextEngineRuntimeQuarantine | undefined {
  return contextEngineRegistryState.quarantinedEngines.get(engineId);
}

export async function listContextEngineQuarantines(): Promise<ContextEngineRuntimeQuarantine[]> {
  const persisted = await listPersistedContextEngineQuarantines();
  const quarantines = Array.from(
    contextEngineRegistryState.quarantinedEngines.values(),
    ({ failedAt, ...quarantine }) => ({ ...quarantine, failedAt: new Date(failedAt) }),
  );
  const seenEngineIds = new Set(quarantines.map((entry) => entry.engineId));
  return quarantines.concat(persisted.filter(({ engineId }) => !seenEngineIds.has(engineId)));
}

export async function clearContextEngineRuntimeQuarantine(
  engineId: string,
  assertCurrent: () => void,
): Promise<void> {
  contextEngineRegistryState.quarantinedEngines.delete(engineId);
  // Every logical turn re-registers the never-quarantined default engine, so
  // skip the worker round trip when this process has no record to clear.
  if (!contextEngineRegistryState.persistedQuarantineEngineIds.has(engineId)) {
    return;
  }
  const cleared = await clearPersistedContextEngineQuarantineForProcess(
    engineId,
    process.pid,
    () => {
      assertCurrent();
      if (contextEngineRegistryState.quarantinedEngines.has(engineId)) {
        throw new Error("Context engine quarantine changed during recovery");
      }
    },
  );
  forgetClearedPersistedQuarantine(engineId, cleared);
}

export function clearContextEngineQuarantineForActivation(engineId: string): void {
  contextEngineRegistryState.quarantinedEngines.delete(engineId);
  if (!contextEngineRegistryState.persistedQuarantineEngineIds.has(engineId)) {
    return;
  }
  forgetClearedPersistedQuarantine(
    engineId,
    clearPersistedContextEngineQuarantineForActivation(engineId),
  );
}

function forgetClearedPersistedQuarantine(engineId: string, cleared: boolean): void {
  // A quarantine recorded while the clear was in flight owns a new row.
  if (cleared && !contextEngineRegistryState.quarantinedEngines.has(engineId)) {
    contextEngineRegistryState.persistedQuarantineEngineIds.delete(engineId);
  }
}
