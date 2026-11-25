import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  beginPluginStateMutation,
  capturePluginStateMutationSettlement,
} from "./plugin-state-operation-epochs.js";
import type {
  PluginStatePublicationEffect,
  PluginStatePublicationScope,
} from "./plugin-state-publication.js";
import { isRetainedPluginStateNamespace } from "./plugin-state-store.kernel.js";
import type { PluginStateWorkerOperations } from "./plugin-state-worker-contract.js";

export type PluginStateCommandOrder = { ready: Promise<void> | undefined; finish?: () => void };
type PluginStateCommand = SqliteWorkerCommand<PluginStateWorkerOperations>;

export function publicationScope(
  command: PluginStateCommand,
): PluginStatePublicationScope | undefined {
  switch (command.type) {
    case "pluginState.register":
    case "pluginState.registerIfAbsent":
    case "pluginState.replaceEntry":
    case "pluginState.compareUpdate": {
      const { pluginId, namespace, key, overflowPolicy } = command.input;
      // These policies cannot evict another live key; readers already filter expiry.
      return {
        pluginId,
        namespace,
        ...(overflowPolicy === "reject-new" || isRetainedPluginStateNamespace(namespace)
          ? { key }
          : {}),
      };
    }
    case "pluginState.observe":
    case "pluginState.consume":
    case "pluginState.delete":
    case "pluginState.deleteIfEqual":
    case "pluginState.compareDelete": {
      const { pluginId, namespace, key } = command.input;
      return { pluginId, namespace, key };
    }
    case "pluginState.replace":
    case "pluginState.clear":
    case "pluginState.clearRuntimeHealth": {
      const { pluginId, namespace } = command.input;
      return { pluginId, namespace };
    }
    default:
      // Compound operations retain database-wide denial without an exact write scope.
      return undefined;
  }
}

export function prepareCommandOrder(
  coordinationKey: string,
  command: PluginStateCommand,
): PluginStateCommandOrder | undefined {
  switch (command.type) {
    case "pluginState.executeOperation":
      return undefined;
    case "pluginState.loadNamespace":
    case "pluginState.lookup":
    case "pluginState.lookupMany":
    case "pluginState.entries":
    case "pluginState.entriesInKeyRange":
    case "pluginState.count":
    case "pluginState.observe":
      return { ready: capturePluginStateMutationSettlement(coordinationKey, [command.input]) };
    case "pluginState.appendJournal":
      return beginPluginStateMutation(coordinationKey, [
        { pluginId: command.input.pluginId, namespace: command.input.cursorNamespace },
        { pluginId: command.input.pluginId, namespace: command.input.journalNamespace },
      ]);
    case "pluginState.moveEntries":
      return beginPluginStateMutation(coordinationKey, [
        command.input,
        { ...command.input, namespace: command.input.sourceNamespace },
      ]);
    default:
      return beginPluginStateMutation(coordinationKey, [command.input]);
  }
}

export function publicationEffect(
  command: PluginStateCommand,
  scope: PluginStatePublicationScope | undefined,
): PluginStatePublicationEffect | undefined {
  if (command.type === "pluginState.observe") {
    return Object.freeze({ kind: "unchanged" });
  }
  // Only exact-key CAS writes have a bounded set of possible values: the
  // committed row on conflict/rollback, or this immutable serialized postimage.
  if (command.type === "pluginState.compareUpdate" && scope?.key !== undefined) {
    if (command.input.action === "keep") {
      return Object.freeze({ kind: "unchanged" });
    }
    if (command.input.ttlMs === undefined) {
      return Object.freeze({ kind: "postimage", valueJson: command.input.valueJson });
    }
  }
  return undefined;
}
