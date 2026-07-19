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
import type { PluginRegistry } from "./registry-types.js";

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

// A shallow clone leaves nested registration objects (e.g. hook/tool entries)
// shared with the live registry, so in-transaction mutations survive a rollback
// and orphan registers remain in the manifest cache (#107514). Deep clone nested
// data so restore fully reverts nested config changes, but preserve value
// semantics: function-valued fields and unclonable class instances stay by
// reference (they are never mutated), while typed values such as Date keep their
// constructor across snapshot/restore (#107514).
type RegistryValue =
  | PluginRegistry
  | unknown[]
  | Map<unknown, unknown>
  | ((...args: unknown[]) => unknown)
  | Record<string, unknown>
  | null
  | undefined
  | unknown;

function cloneTypedValue(value: object): unknown {
  // Prefer a structured clone so typed values (Date, etc.) keep their
  // constructor, but structuredClone silently drops custom-class prototypes,
  // turning instances into plain objects. If the clone lost the original
  // prototype, keep the original by reference instead: registry values are
  // never mutated in place, so sharing the reference across rollback is safe
  // and preserves type identity for plugin-provided metadata (#107514).
  try {
    const cloned = structuredClone(value);
    if (Object.getPrototypeOf(cloned) === Object.getPrototypeOf(value)) {
      return cloned;
    }
    return value;
  } catch {
    return value;
  }
}

function deepCloneRegistryValue(value: RegistryValue): RegistryValue {
  if (typeof value === "function") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepCloneRegistryValue(item));
  }
  if (value instanceof Map) {
    const cloned = new Map<unknown, unknown>();
    for (const [key, val] of value) {
      cloned.set(key, deepCloneRegistryValue(val));
    }
    return cloned;
  }
  if (value && typeof value === "object") {
    // Plain objects (direct Object.prototype) keep recursive deep cloning so
    // nested mutations revert; other prototypes (Date, URL, Error, ...) retain
    // their typed semantics via structuredClone.
    if (Object.getPrototypeOf(value) === Object.prototype) {
      const cloned: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        cloned[key] = deepCloneRegistryValue(val);
      }
      return cloned;
    }
    return cloneTypedValue(value);
  }
  return value;
}

function snapshotPluginRegistry(registry: PluginRegistry): PluginRegistry {
  const snapshot = {} as PluginRegistry;
  for (const [key, value] of Object.entries(registry)) {
    (snapshot as Record<string, unknown>)[key] = deepCloneRegistryValue(value as RegistryValue);
  }
  return snapshot;
}

function restorePluginRegistry(registry: PluginRegistry, snapshot: PluginRegistry): void {
  Object.assign(registry, snapshot);
}

type PluginRegistrationTransaction = {
  commit: (params: { activate: boolean }) => void;
  rollback: () => void;
};

export function createPluginRegistrationTransaction(params: {
  registry?: PluginRegistry;
  rollbackGlobalSideEffects?: () => void;
}): PluginRegistrationTransaction {
  const registrySnapshot = params.registry ? snapshotPluginRegistry(params.registry) : undefined;
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
        if (params.registry && registrySnapshot) {
          restorePluginRegistry(params.registry, registrySnapshot);
        }
        restorePluginProcessGlobalState(processGlobalState);
      });
    },
  };
}
