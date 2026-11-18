import { expectTypeOf } from "vitest";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "../../src/plugin-sdk/plugin-state-runtime.js";
import type {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "../../src/plugin-sdk/plugin-state-store-runtime.js";

// plugin state store type contracts
// guarantees atomic capabilities from the concrete SDK factory
expectTypeOf<ReturnType<typeof createPluginStateKeyedStore<{ count: number }>>>().toEqualTypeOf<
  Required<PluginStateKeyedStore<{ count: number }>>
>();
expectTypeOf<ReturnType<typeof createPluginStateSyncKeyedStore<{ count: number }>>>().toEqualTypeOf<
  Required<PluginStateSyncKeyedStore<{ count: number }>>
>();

// allows general stores without optional capabilities
expectTypeOf<
  Omit<PluginStateKeyedStore<{ count: number }>, "update" | "deleteIf" | "lookupMany">
>().toExtend<PluginStateKeyedStore<{ count: number }>>();
expectTypeOf<
  Omit<PluginStateSyncKeyedStore<{ count: number }>, "update" | "deleteIf" | "lookupMany">
>().toExtend<PluginStateSyncKeyedStore<{ count: number }>>();
