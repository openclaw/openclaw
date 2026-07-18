// Owns atomic plugin registration state across registry and process-global capabilities.
import {
  listRegisteredAgentHarnesses,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  restoreDetachedTaskLifecycleRuntimeRegistration,
} from "../tasks/detached-task-runtime-state.js";
import { listRegisteredPluginCommands, restorePluginCommands } from "./command-registry-state.js";
import {
  listRegisteredCompactionProviders,
  restoreRegisteredCompactionProviders,
} from "./compaction-provider.js";
import {
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
} from "./embedding-providers.js";
import {
  listPluginInteractiveHandlers,
  restorePluginInteractiveHandlers,
} from "./interactive-registry.js";
import {
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "./memory-embedding-providers.js";
import {
  getMemoryCapabilityRegistration,
  listMemoryCorpusSupplements,
  listMemoryPromptPreparations,
  listMemoryPromptSupplements,
  restoreMemoryPluginState,
} from "./memory-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

export type PluginProcessGlobalState = {
  agentHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;
  commands: ReturnType<typeof listRegisteredPluginCommands>;
  compactionProviders: ReturnType<typeof listRegisteredCompactionProviders>;
  detachedTaskRuntimeRegistration: ReturnType<typeof getDetachedTaskLifecycleRuntimeRegistration>;
  embeddingProviders: ReturnType<typeof listRegisteredEmbeddingProviders>;
  interactiveHandlers: ReturnType<typeof listPluginInteractiveHandlers>;
  memoryCapability: ReturnType<typeof getMemoryCapabilityRegistration>;
  memoryCorpusSupplements: ReturnType<typeof listMemoryCorpusSupplements>;
  memoryEmbeddingProviders: ReturnType<typeof listRegisteredMemoryEmbeddingProviders>;
  memoryPromptPreparations: ReturnType<typeof listMemoryPromptPreparations>;
  memoryPromptSupplements: ReturnType<typeof listMemoryPromptSupplements>;
};

export function snapshotPluginProcessGlobalState(): PluginProcessGlobalState {
  return {
    agentHarnesses: listRegisteredAgentHarnesses(),
    commands: listRegisteredPluginCommands(),
    compactionProviders: listRegisteredCompactionProviders(),
    detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
    embeddingProviders: listRegisteredEmbeddingProviders(),
    interactiveHandlers: listPluginInteractiveHandlers(),
    memoryCapability: getMemoryCapabilityRegistration(),
    memoryCorpusSupplements: listMemoryCorpusSupplements(),
    memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
    memoryPromptPreparations: listMemoryPromptPreparations(),
    memoryPromptSupplements: listMemoryPromptSupplements(),
  };
}

export function restorePluginProcessGlobalState(state: PluginProcessGlobalState): void {
  restoreRegisteredAgentHarnesses(state.agentHarnesses);
  restorePluginCommands(state.commands);
  restoreRegisteredCompactionProviders(state.compactionProviders);
  restoreDetachedTaskLifecycleRuntimeRegistration(state.detachedTaskRuntimeRegistration);
  restoreRegisteredEmbeddingProviders(state.embeddingProviders);
  restorePluginInteractiveHandlers(state.interactiveHandlers);
  restoreRegisteredMemoryEmbeddingProviders(state.memoryEmbeddingProviders);
  restoreMemoryPluginState({
    capability: state.memoryCapability,
    corpusSupplements: state.memoryCorpusSupplements,
    promptPreparations: state.memoryPromptPreparations,
    promptSupplements: state.memoryPromptSupplements,
  });
}

function cloneRegistrationEnvelope<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  // Registration envelopes own their metadata arrays and dates. Nested plugin runtime
  // objects and callbacks keep their identity because the transaction does not own them.
  const clone = { ...value } as Record<string, unknown>;
  for (const [key, field] of Object.entries(clone)) {
    if (Array.isArray(field)) {
      clone[key] = [...field];
    } else if (field instanceof Date) {
      clone[key] = new Date(field);
    }
  }
  return clone as T;
}

type PluginRegistrySnapshot = {
  registry: PluginRegistry;
  currentRecord?: PluginRecord;
};

function snapshotPluginRegistry(
  registry: PluginRegistry,
  currentRecord?: PluginRecord,
): PluginRegistrySnapshot {
  return {
    registry: Object.fromEntries(
      Object.entries(registry).map(([key, value]) => {
        if (Array.isArray(value)) {
          return [key, value.map((entry) => cloneRegistrationEnvelope(entry))];
        }
        if (value instanceof Map) {
          return [
            key,
            new Map(
              [...value].map(([entryKey, entry]) => [entryKey, cloneRegistrationEnvelope(entry)]),
            ),
          ];
        }
        if (value && typeof value === "object") {
          return [key, cloneRegistrationEnvelope(value)];
        }
        return [key, value];
      }),
    ) as PluginRegistry,
    currentRecord: currentRecord ? cloneRegistrationEnvelope(currentRecord) : undefined,
  };
}

function restorePluginRegistry(
  registry: PluginRegistry,
  snapshot: PluginRegistrySnapshot,
  currentRecord?: PluginRecord,
): void {
  if (currentRecord && snapshot.currentRecord) {
    // Registration mutates this record before registry.plugins owns it; restore the same
    // object so the subsequent error entry reports only committed metadata.
    for (const key of Object.keys(currentRecord)) {
      Reflect.deleteProperty(currentRecord, key);
    }
    Object.assign(currentRecord, snapshot.currentRecord);
  }
  Object.assign(registry, snapshot.registry);
}

type PluginRegistrationTransaction = {
  commit: (params: { activate: boolean }) => void;
  rollback: () => void;
};

export function createPluginRegistrationTransaction(params: {
  registry: PluginRegistry;
  /** Record mutated by register() before registry.plugins owns it. */
  currentRecord?: PluginRecord;
  rollbackGlobalSideEffects?: () => void;
}): PluginRegistrationTransaction {
  const registrySnapshot = snapshotPluginRegistry(params.registry, params.currentRecord);
  const processGlobalState = snapshotPluginProcessGlobalState();
  let settled = false;

  const settle = (action: () => void): void => {
    if (settled) {
      return;
    }
    action();
    settled = true;
  };

  return {
    commit: ({ activate }) => {
      settle(() => {
        if (!activate) {
          restorePluginProcessGlobalState(processGlobalState);
        }
      });
    },
    rollback: () => {
      settle(() => {
        params.rollbackGlobalSideEffects?.();
        restorePluginRegistry(params.registry, registrySnapshot, params.currentRecord);
        restorePluginProcessGlobalState(processGlobalState);
      });
    },
  };
}
