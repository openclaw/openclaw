import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { testing as sessionBindingTesting } from "../infra/outbound/session-binding-service.js";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  isPluginRecordActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type TelegramStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredTelegramBinding = {
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
};
type TelegramStore = ReturnType<
  typeof createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>
>;
type CreateTelegramThreadBindingManager = (params: {
  cfg: { channels: { telegram: { botToken: string } } };
  accountId: string;
  persist: boolean;
  enableSweeper: boolean;
}) => Promise<{ stop: () => Promise<void> }>;

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
// The observer store uses this no-op authority; Telegram's runtime store runs production checks.
const storeAuthority = { assertCurrent() {} };

let setTelegramRuntime: (runtime: PluginRuntime) => void;
let createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;

beforeAll(async () => {
  ({ createTelegramThreadBindingManager, setTelegramRuntime } = await loadBundledPluginFacade<{
    createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;
    setTelegramRuntime: (runtime: PluginRuntime) => void;
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

async function readStoredTarget(store: TelegramStore): Promise<StoredTelegramBinding | undefined> {
  const row = (await store.entries()).find(
    (entry) =>
      entry.value.accountId === conversation.accountId &&
      entry.value.conversationId === conversation.conversationId,
  );
  return row ? structuredClone(row.value) : undefined;
}

async function createRegistryRuntimeFixture() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-conversation-binding-registry-",
  });
  onTestFinished(() => state.cleanup());
  resetPluginStateStoreForTests();
  onTestFinished(() => resetPluginStateStoreForTests());
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
  const codex = new PluginInstance("codex");
  onTestFinished(async () => expect((await codex.dispose()).errors).toEqual([]));
  const gate = createRegistrationGate();

  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "telegram", origin: "bundled" });
  const api = builder.createApi(record, { config: telegramConfig, registrationMode: "full" });
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
      const runtimeState = value as PluginRuntime["state"];
      return {
        ...runtimeState,
        // SAFETY: This fixture serves only Telegram's thread-binding namespace and record type.
        openKeyedStoreV2: ((options: TelegramStoreOptions) => {
          openedStore.options = options;
          const store = runtimeState.openKeyedStoreV2<StoredTelegramBinding>(options);
          gate.intercept(store);
          return store;
        }) as PluginRuntime["state"]["openKeyedStoreV2"],
      };
    },
  });

  // The manager starts inside Telegram's instance, as channel startup does.
  const manager = await telegram.run(async () => {
    setTelegramRuntime(gatedRuntime);
    return await createTelegramThreadBindingManager({
      cfg: telegramConfig,
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
  });
  onTestFinished(() => manager.stop());
  await telegram.run(() =>
    bindConversationNow({ identity: codexIdentity, conversation, summary: "original" }),
  );

  const observer = createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>(
    "telegram",
    expectDefined(openedStore.options, "Telegram registry binding store options"),
    storeAuthority,
  );
  const snapshot = expectDefined(
    await readStoredTarget(observer),
    "seeded registry-owned Telegram binding",
  );

  return {
    gate,
    builder,
    record,
    snapshot,
    read: () => readStoredTarget(observer),
    refresh: () =>
      codex.run(() =>
        requestPluginConversationBinding({
          ...codexIdentity,
          conversation,
          binding: { summary: "refreshed" },
        }),
      ),
    detach: () =>
      codex.run(() =>
        detachPluginConversationBinding({
          pluginRoot: codexIdentity.pluginRoot,
          conversation,
        }),
      ),
  };
}

describe("plugin conversation bindings across plugin instances", () => {
  it("lets the owning plugin root refresh a Telegram binding across plugin instances", async () => {
    const fixture = await createRegistryRuntimeFixture();
    expect(await fixture.refresh()).toMatchObject({ status: "bound" });
    expect(await fixture.read()).toMatchObject({
      metadata: { pluginRoot: "/plugins/codex-a", summary: "refreshed" },
    });
  });

  it("lets the owning plugin root detach a Telegram binding across plugin instances", async () => {
    const fixture = await createRegistryRuntimeFixture();
    expect(await fixture.detach()).toEqual({ removed: true });
    expect(await fixture.read()).toBeUndefined();
  });

  it("rejects a queued Telegram write when its registry owner is retired", async ({ signal }) => {
    const fixture = await createRegistryRuntimeFixture();
    fixture.gate.arm();
    const request = fixture.refresh();
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
    expect(await fixture.read()).toEqual(fixture.snapshot);
  });
});
