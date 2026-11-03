import { afterAll, afterEach, beforeAll, beforeEach, it, vi } from "vitest";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as namespaceOwner from "./plugin-state-namespace-owner.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  type OpenKeyedStoreOptions,
} from "./plugin-state-store.js";
import { clearPluginStateStoreForTests } from "./plugin-state-store.test-helpers.js";

export function observePluginStateReads(onLoaded?: () => void | Promise<void>) {
  const reads = vi.fn<() => void>();
  const ensureNamespace = namespaceOwner.ensurePluginStateNamespace;
  const executeRead = stateRead.executeExistingOpenClawStateRead;
  vi.spyOn(namespaceOwner, "ensurePluginStateNamespace").mockImplementation(
    (identity, scope, load) =>
      ensureNamespace(identity, scope, async (maxBytes) => {
        reads();
        const rows = await load(maxBytes);
        await onLoaded?.();
        return rows;
      }),
  );
  vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementation((...args) => {
    reads();
    return executeRead(...args);
  });
  return reads;
}

export function keyedStores<T>(pluginId: string, options: OpenKeyedStoreOptions) {
  return {
    store: createPluginStateKeyedStore<T>(pluginId, options),
    sync: createPluginStateSyncKeyedStore<T>(pluginId, options),
  };
}

export function keyedStore<T>(
  pluginId: string,
  namespace: string,
  options: Partial<OpenKeyedStoreOptions> = {},
) {
  return createPluginStateKeyedStore<T>(pluginId, { maxEntries: 10, ...options, namespace });
}

export function syncKeyedStore<T>(
  pluginId: string,
  namespace: string,
  options: Partial<OpenKeyedStoreOptions> = {},
) {
  return createPluginStateSyncKeyedStore<T>(pluginId, { maxEntries: 10, ...options, namespace });
}

export function stateTest(label: string, applyEnv = true) {
  return it.extend<{ state: OpenClawTestState }>({
    state: async ({ task }, use) => {
      await withOpenClawTestState({ label: `${label}-${task.id}`, applyEnv }, use);
    },
  });
}

export function useState(label: string, clear = true, closeBetween = false) {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label });
  });
  beforeEach(() => {
    state.applyEnv();
    if (clear) {
      clearPluginStateStoreForTests();
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPluginStateStoreForTests({ closeDatabase: closeBetween });
  });
  afterAll(async () => {
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  return () => state;
}
