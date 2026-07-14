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
    promptSupplements: state.memoryPromptSupplements,
  });
}

type ObjectStateSnapshot = Map<PropertyKey, PropertyDescriptor>;

type PluginRecordSnapshot = {
  record: PluginRecord;
  state: ObjectStateSnapshot;
};

type PluginRegistrySnapshot = {
  registry: PluginRegistry;
  pluginRecords: PluginRecordSnapshot[];
};

function cloneMutablePropertyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value instanceof Date) {
    return new Date(value);
  }
  return value;
}

function snapshotObjectState(value: object): ObjectStateSnapshot {
  return new Map(
    Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        throw new Error(`missing property descriptor for ${String(key)}`);
      }
      return [
        key,
        "value" in descriptor
          ? { ...descriptor, value: cloneMutablePropertyValue(descriptor.value) }
          : descriptor,
      ];
    }),
  );
}

function restoreObjectState(value: object, snapshot: ObjectStateSnapshot): void {
  for (const key of Reflect.ownKeys(value)) {
    if (!snapshot.has(key)) {
      Reflect.deleteProperty(value, key);
    }
  }
  for (const [key, descriptor] of snapshot) {
    Object.defineProperty(
      value,
      key,
      "value" in descriptor
        ? { ...descriptor, value: cloneMutablePropertyValue(descriptor.value) }
        : descriptor,
    );
  }
}

function cloneRegistryArrayEntry<T>(entry: T): T {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }
  const clone = Object.create(Object.getPrototypeOf(entry));
  restoreObjectState(clone, snapshotObjectState(entry));
  return clone as T;
}

function snapshotPluginRegistry(
  registry: PluginRegistry,
  currentRecord?: PluginRecord,
): PluginRegistrySnapshot {
  const records = currentRecord ? [...registry.plugins, currentRecord] : registry.plugins;
  return {
    registry: Object.fromEntries(
      Object.entries(registry).map(([key, value]) => {
        if (Array.isArray(value)) {
          return [key, value.map((entry) => cloneRegistryArrayEntry(entry))];
        }
        if (value instanceof Map) {
          return [key, new Map(value)];
        }
        if (value && typeof value === "object") {
          return [key, cloneRegistryArrayEntry(value)];
        }
        return [key, value];
      }),
    ) as PluginRegistry,
    pluginRecords: [...new Set(records)].map((record) => ({
      record,
      state: snapshotObjectState(record),
    })),
  };
}

function restorePluginRegistry(registry: PluginRegistry, snapshot: PluginRegistrySnapshot): void {
  for (const { record, state } of snapshot.pluginRecords) {
    restoreObjectState(record, state);
  }
  Object.assign(registry, snapshot.registry);
}

type PluginRegistrationTransaction = {
  commit: (params: { activate: boolean }) => void;
  rollback: () => void;
};

export function createPluginRegistrationTransaction(params: {
  registry: PluginRegistry;
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
        restorePluginRegistry(params.registry, registrySnapshot);
        restorePluginProcessGlobalState(processGlobalState);
      });
    },
  };
}
