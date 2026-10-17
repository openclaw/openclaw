import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  registerSessionBindingAdapterV2,
  testing as sessionBindingTesting,
  type SessionBindingAdapterV2,
} from "../infra/outbound/session-binding-service.js";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getPluginInstance, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  isPluginRecordActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

type TelegramRuntime = ReturnType<typeof createPluginRuntimeMock>;
type TelegramStoreOptions = Parameters<TelegramRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredTelegramBinding = {
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
};
type TelegramStore = ReturnType<
  typeof createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>
>;
type TelegramThreadBindingManager = {
  stop: () => Promise<void>;
};
type TelegramPluginInstance = Pick<PluginInstanceHandle, "run" | "dispose">;
type CreateTelegramThreadBindingManager = (params: {
  cfg: { channels: { telegram: { botToken: string } } };
  accountId: string;
  persist: boolean;
  enableSweeper: boolean;
}) => Promise<TelegramThreadBindingManager>;

const telegramConfig = {
  channels: { telegram: { botToken: "test-token" } },
};
const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "-10099:topic:42",
  parentConversationId: "-10099",
  threadId: "42",
};
const codexIdentity = {
  pluginId: "codex",
  pluginName: "Codex",
  pluginRoot: "/plugins/codex-a",
};
// Test-opened stores use this no-op authority; only the registry fixture's runtime store runs production checks.
const storeAuthority = {
  assertCurrent() {},
};

let setTelegramRuntime: (runtime: TelegramRuntime) => void;
let createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;

beforeAll(async () => {
  ({ createTelegramThreadBindingManager, setTelegramRuntime } = await loadBundledPluginFacade<{
    createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;
    setTelegramRuntime: (runtime: TelegramRuntime) => void;
  }>({ pluginId: "telegram", artifactBasename: "runtime-api.js" }));
});

function createRegistrationGate() {
  const entered = createDeferred();
  const release = createDeferred();
  let armed = false;

  return {
    entered,
    release,
    arm() {
      // Telegram reopens the store for every write, so callers arm only after the seed write.
      armed = true;
    },
    intercept(store: TelegramStore) {
      if (!armed) {
        return;
      }
      armed = false;
      const register = store.register.bind(store);
      vi.spyOn(store, "register").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return await register(...args);
      });
    },
  };
}

type RegistrationGate = ReturnType<typeof createRegistrationGate>;

async function createFixtureBase(prefix: string) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix,
  });
  onTestFinished(() => state.cleanup());

  resetPluginStateStoreForTests();
  onTestFinished(() => resetPluginStateStoreForTests());

  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

  const codex = new PluginInstance("codex");
  onTestFinished(async () => expect((await codex.dispose()).errors).toEqual([]));

  const other = new PluginInstance("other-plugin");
  onTestFinished(async () => expect((await other.dispose()).errors).toEqual([]));

  return {
    codex,
    other,
    gate: createRegistrationGate(),
  };
}

function createMockOpenKeyedStoreV2(gate: RegistrationGate) {
  const stores = new Map<string, TelegramStore>();
  // SAFETY: This fixture serves only Telegram's thread-binding namespace and record type.
  const openKeyedStoreV2 = ((options: TelegramStoreOptions) => {
    let store = stores.get(options.namespace);
    if (!store) {
      store = createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>(
        "telegram",
        options,
        storeAuthority,
      );
      stores.set(options.namespace, store);
    }
    gate.intercept(store);
    return store;
  }) as TelegramRuntime["state"]["openKeyedStoreV2"];
  return { openKeyedStoreV2, stores };
}

async function readStoredTarget(store: TelegramStore): Promise<StoredTelegramBinding | undefined> {
  const row = (await store.entries()).find(
    (entry) =>
      entry.value.accountId === conversation.accountId &&
      entry.value.conversationId === conversation.conversationId,
  );
  return row ? structuredClone(row.value) : undefined;
}

async function createTelegramManager(
  telegram: TelegramPluginInstance,
  runtime: TelegramRuntime,
): Promise<TelegramThreadBindingManager> {
  return await telegram.run(async () => {
    setTelegramRuntime(runtime);
    return await createTelegramThreadBindingManager({
      cfg: telegramConfig,
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
  });
}

async function seedTelegramBinding(telegram: TelegramPluginInstance): Promise<void> {
  await telegram.run(async () => {
    await bindConversationNow({
      identity: codexIdentity,
      conversation,
      summary: "original",
    });
  });
}

async function createMockRuntimeFixture() {
  const base = await createFixtureBase("openclaw-conversation-binding-cross-instance-");

  const telegram = new PluginInstance("telegram");
  onTestFinished(async () => expect((await telegram.dispose()).errors).toEqual([]));

  const { openKeyedStoreV2, stores } = createMockOpenKeyedStoreV2(base.gate);
  const manager = await createTelegramManager(
    telegram,
    createPluginRuntimeMock({
      state: { openKeyedStoreV2 },
    }),
  );
  onTestFinished(() => manager.stop());

  await seedTelegramBinding(telegram);

  const store = expectDefined(stores.get("telegram.thread-bindings"), "Telegram binding store");
  const snapshot = expectDefined(await readStoredTarget(store), "seeded Telegram binding");

  return { ...base, telegram, store, snapshot };
}

function createDisabledAdapter(): SessionBindingAdapterV2 {
  // This models bot-core replacing its adapter outside the writer queue.
  return {
    version: 2,
    assertCurrent() {},
    channel: "telegram",
    accountId: "default",
    capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
    touchAsync: async () => {},
    listBySessionAsync: async () => [],
    resolveByConversationAsync: async () => null,
    inspectByConversationAsync: async () => null,
    inspectByConversationsAsync: async (refs) => ({
      bindings: refs.map(() => null),
      assertCurrent() {},
    }),
    listBySession: () => [],
    resolveByConversation: () => null,
  };
}

async function createRegistryRuntimeFixture() {
  const base = await createFixtureBase("openclaw-conversation-binding-registry-");

  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "telegram", origin: "bundled" });
  const api = builder.createApi(record, {
    config: telegramConfig,
    registrationMode: "full",
  });
  const telegram = expectDefined(getPluginInstance(record), "registered Telegram plugin instance");
  onTestFinished(async () => expect((await telegram.dispose()).errors).toEqual([]));

  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  onTestFinished(() => markPluginRegistryRetired(builder.registry));

  const openedStore: { options?: TelegramStoreOptions } = {};
  const gatedRuntime = new Proxy(api.runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "state") {
        return value;
      }
      const runtimeState = value as TelegramRuntime["state"];
      return {
        ...runtimeState,
        // SAFETY: This fixture serves only Telegram's thread-binding namespace and record type.
        openKeyedStoreV2: ((options: TelegramStoreOptions) => {
          openedStore.options = options;
          const store = runtimeState.openKeyedStoreV2<StoredTelegramBinding>(options);
          base.gate.intercept(store);
          return store;
        }) as TelegramRuntime["state"]["openKeyedStoreV2"],
      };
    },
  });

  const manager = await createTelegramManager(telegram, gatedRuntime);
  onTestFinished(() => manager.stop());

  await seedTelegramBinding(telegram);

  const storeOptions = expectDefined(
    openedStore.options,
    "Telegram registry binding store options",
  );
  const observer = createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>(
    "telegram",
    storeOptions,
    storeAuthority,
  );
  const snapshot = expectDefined(
    await readStoredTarget(observer),
    "seeded registry-owned Telegram binding",
  );

  return {
    ...base,
    builder,
    record,
    observer,
    snapshot,
  };
}

describe("plugin conversation bindings across plugin instances", () => {
  it("lets the owning plugin root refresh a Telegram binding across plugin instances", async () => {
    const fixture = await createMockRuntimeFixture();
    const result = await fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation,
        binding: { summary: "refreshed" },
      }),
    );
    expect(result).toMatchObject({ status: "bound" });
    expect(await readStoredTarget(fixture.store)).toMatchObject({
      metadata: {
        pluginRoot: "/plugins/codex-a",
        summary: "refreshed",
      },
    });
  });

  it("lets the owning plugin root detach a Telegram binding across plugin instances", async () => {
    const fixture = await createMockRuntimeFixture();
    const result = await fixture.codex.run(() =>
      detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-a",
        conversation,
      }),
    );
    expect(result).toEqual({ removed: true });
    expect(await readStoredTarget(fixture.store)).toBeUndefined();
  });

  it("rejects a different plugin root without touching stored Telegram routing", async () => {
    const fixture = await createMockRuntimeFixture();
    const result = await fixture.other.run(async () => {
      const request = await requestPluginConversationBinding({
        pluginId: "other-plugin",
        pluginName: "Other Plugin",
        pluginRoot: "/plugins/other",
        conversation,
        binding: { summary: "refreshed" },
      });
      const detach = await detachPluginConversationBinding({
        pluginRoot: "/plugins/other",
        conversation,
      });
      return { request, detach };
    });

    expect(result.request).toEqual({
      status: "error",
      message: 'This conversation is already bound by plugin "Codex".',
    });
    expect(result.detach).toEqual({ removed: false });
    expect(await readStoredTarget(fixture.store)).toEqual(fixture.snapshot);
  });

  it("rejects detaching after the Telegram plugin instance is quiesced", async () => {
    const fixture = await createMockRuntimeFixture();
    fixture.telegram.quiesce();
    const detach = fixture.codex.run(() =>
      detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-a",
        conversation,
      }),
    );

    await expect(detach).rejects.toThrow(
      "Plugin telegram was reloaded or disabled; use its current tools.",
    );
    expect(await readStoredTarget(fixture.store)).toEqual(fixture.snapshot);
  });

  it("rejects a queued Telegram write when its session binding adapter is replaced", async ({
    signal,
  }) => {
    const fixture = await createMockRuntimeFixture();
    fixture.gate.arm();
    const request = fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation,
        binding: { summary: "refreshed" },
      }),
    );
    onTestFinished(async () => {
      fixture.gate.release.resolve();
      await Promise.allSettled([request]);
    });

    await withinTest(
      awaitGateBeforeSettlement(
        fixture.gate.entered.promise,
        request,
        "Telegram binding request settled before reaching the queued store write",
      ),
      signal,
    );

    registerSessionBindingAdapterV2(createDisabledAdapter());
    fixture.gate.release.resolve();

    await expect(request).rejects.toThrow("Session binding owner changed for telegram:default");
    expect(await readStoredTarget(fixture.store)).toEqual(fixture.snapshot);
  });

  it("rejects a queued Telegram write when its registry owner is retired", async ({ signal }) => {
    const fixture = await createRegistryRuntimeFixture();
    fixture.gate.arm();
    const request = fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation,
        binding: { summary: "refreshed" },
      }),
    );
    onTestFinished(async () => {
      fixture.gate.release.resolve();
      await Promise.allSettled([request]);
    });

    await withinTest(
      awaitGateBeforeSettlement(
        fixture.gate.entered.promise,
        request,
        "Telegram binding request settled before reaching the registry-owned queued write",
      ),
      signal,
    );

    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(true);
    markPluginRegistryRetired(fixture.builder.registry);
    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(false);
    fixture.gate.release.resolve();

    await expect(request).rejects.toThrow('Plugin "telegram" runtime is no longer active.');
    expect(await readStoredTarget(fixture.observer)).toEqual(fixture.snapshot);
  });
});
