import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-store-runtime";
import type { SessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import type {
  AccountScopedConversationBindingManager,
  AccountScopedConversationBindingRecord,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { expectTypeOf, it } from "vitest";

it("retains the v2026.9.8 keyed-state callback and synchronous completion contracts", () => {
  type Value = { count: number };
  type ReleasedUpdate = (
    key: string,
    update: (current: Value | undefined) => Value | undefined,
    options?: { ttlMs?: number },
  ) => boolean;
  type ReleasedDeleteIf = (key: string, predicate: (current: Value) => boolean) => boolean;

  expectTypeOf<
    NonNullable<PluginStateSyncKeyedStore<Value>["update"]>
  >().toEqualTypeOf<ReleasedUpdate>();
  expectTypeOf<
    NonNullable<PluginStateSyncKeyedStore<Value>["deleteIf"]>
  >().toEqualTypeOf<ReleasedDeleteIf>();
  expectTypeOf<NonNullable<PluginStateKeyedStore<Value>["update"]>>().toEqualTypeOf<
    (...args: Parameters<ReleasedUpdate>) => Promise<boolean>
  >();
  expectTypeOf<NonNullable<PluginStateKeyedStore<Value>["deleteIf"]>>().toEqualTypeOf<
    (...args: Parameters<ReleasedDeleteIf>) => Promise<boolean>
  >();
  expectTypeOf<ReturnType<typeof createPluginStateSyncKeyedStore<Value>>>().toExtend<
    PluginStateSyncKeyedStore<Value>
  >();
  expectTypeOf<ReturnType<typeof createPluginStateKeyedStore<Value>>>().toExtend<
    PluginStateKeyedStore<Value>
  >();
  expectTypeOf<ReturnType<PluginStateSyncKeyedStore<Value>["consume"]>>().toEqualTypeOf<
    Value | undefined
  >();
});

it("accepts a v2026.9.8 adapter without any newly introduced async capabilities", () => {
  const releasedAdapter = {
    channel: "released-fixture",
    accountId: "default",
    listBySession: (_sessionKey: string): SessionBindingRecord[] => [],
    resolveByConversation: (): SessionBindingRecord | null => null,
    touch: (_bindingId: string, _at?: number): void => {},
  } satisfies SessionBindingAdapter;
  expectTypeOf(releasedAdapter).toExtend<SessionBindingAdapter>();
  expectTypeOf<ReturnType<SessionBindingService["listBySession"]>>().toEqualTypeOf<
    SessionBindingRecord[]
  >();
  expectTypeOf<
    ReturnType<SessionBindingService["resolveByConversation"]>
  >().toEqualTypeOf<SessionBindingRecord | null>();
  expectTypeOf<ReturnType<SessionBindingService["touch"]>>().toEqualTypeOf<void>();
});

it("retains synchronous account-manager binding and expiry lookup results", () => {
  type Manager = AccountScopedConversationBindingManager<"subagent">;
  type Binding = AccountScopedConversationBindingRecord<"subagent">;
  expectTypeOf<ReturnType<Manager["bindConversation"]>>().toEqualTypeOf<Binding | null>();
  expectTypeOf<ReturnType<Manager["touchConversation"]>>().toEqualTypeOf<Binding | null>();
  expectTypeOf<ReturnType<Manager["getByConversationId"]>>().toEqualTypeOf<Binding | undefined>();
  expectTypeOf<ReturnType<Manager["listBySessionKey"]>>().toEqualTypeOf<Binding[]>();
  expectTypeOf<ReturnType<Manager["stop"]>>().toEqualTypeOf<void>();
});

it("retains v2026.9.8 synchronous Gateway approval publishers without an async callback", () => {
  type Publisher = NonNullable<GatewayRequestHandlerOptions["context"]["approvalEvents"]>;
  const releasedPublisher = {
    publishRequested: (): number => 1,
    publishResolved: (): void => {},
  } satisfies Publisher;
  expectTypeOf(releasedPublisher).toExtend<Publisher>();
  expectTypeOf<ReturnType<Publisher["publishRequested"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReturnType<NonNullable<Publisher["publishRequestedAsync"]>>>().toEqualTypeOf<
    Promise<number>
  >();
});
