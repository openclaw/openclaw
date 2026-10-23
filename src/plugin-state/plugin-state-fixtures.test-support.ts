import { afterAll, afterEach, beforeAll, beforeEach, it, vi } from "vitest";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  type OpenKeyedStoreOptions,
} from "./plugin-state-store.js";
import { clearPluginStateStoreForTests } from "./plugin-state-store.test-helpers.js";

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
