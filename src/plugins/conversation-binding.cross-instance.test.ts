import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
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
import { createTelegramCodexBindRequest } from "./conversation-binding.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  isPluginRecordActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type TelegramStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredBinding = {
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
};
type TelegramStore = ReturnType<typeof createPluginStateKeyedStoreV2ForTests<StoredBinding>>;
type TelegramFacade = {
  setTelegramRuntime: (runtime: PluginRuntime) => void;
  createTelegramThreadBindingManager: (params: {
    cfg: { channels: { telegram: { botToken: string } } };
    accountId: string;
    persist: boolean;
    enableSweeper: boolean;
  }) => Promise<{ stop: () => Promise<void> }>;
};

const telegramConfig = { channels: { telegram: { botToken: "test-token" } } };
const bindingTarget = {
  ...createTelegramCodexBindRequest("-10099:topic:42", "42", "refreshed"),
  pluginName: "Codex",
  requestedBySenderId: undefined,
};
const { conversation } = bindingTarget;
let facade: TelegramFacade;

beforeAll(async () => {
  facade = await loadBundledPluginFacade<TelegramFacade>({
    pluginId: "telegram",
    artifactBasename: "runtime-api.js",
  });
});

async function readStoredTarget(store: TelegramStore): Promise<StoredBinding | undefined> {
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
  const gate = { entered: createDeferred(), release: createDeferred(), armed: false };

  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createTestPluginRegistry(createPluginRuntime());
  const record = createPluginRecord({ id: "telegram", origin: "bundled" });
  const api = builder.createApi(record, { config: telegramConfig, registrationMode: "full" });
  const telegram = expectDefined(getPluginInstance(record), "registered Telegram plugin instance");
  onTestFinished(async () => expect((await telegram.dispose()).errors).toEqual([]));

  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  onTestFinished(() => markPluginRegistryRetired(builder.registry));

  const openedStore: { options?: TelegramStoreOptions } = {};
  const runtimeState = api.runtime.state;
  const gatedState: PluginRuntime["state"] = {
    ...runtimeState,
    openKeyedStoreV2: <T>(options: TelegramStoreOptions) => {
      openedStore.options = options;
      const store = runtimeState.openKeyedStoreV2<T>(options);
      // Telegram reopens its store on writes; arm only after the seed write.
      if (gate.armed) {
        gate.armed = false;
        const register = store.register.bind(store);
        vi.spyOn(store, "register").mockImplementationOnce(async (...args) => {
          gate.entered.resolve();
          await gate.release.promise;
          return await register(...args);
        });
      }
      return store;
    },
  };
  const gatedRuntime = new Proxy(api.runtime, {
    get(target, property) {
      return property === "state" ? gatedState : Reflect.get(target, property, target);
    },
  });

  // The manager starts inside Telegram's instance, as channel startup does.
  const manager = await telegram.run(async () => {
    facade.setTelegramRuntime(gatedRuntime);
    return await facade.createTelegramThreadBindingManager({
      cfg: telegramConfig,
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
  });
  onTestFinished(() => manager.stop());
  await telegram.run(() =>
    bindConversationNow({ identity: bindingTarget, conversation, summary: "original" }),
  );

  const observer = createPluginStateKeyedStoreV2ForTests<StoredBinding>(
    "telegram",
    expectDefined(openedStore.options, "Telegram registry binding store options"),
    // Only the observer bypasses authority; Telegram's runtime store checks the real owner.
    { assertCurrent() {} },
  );
  const snapshot = expectDefined(await readStoredTarget(observer), "seeded Telegram binding");

  return {
    gate,
    builder,
    record,
    snapshot,
    read: () => readStoredTarget(observer),
    refresh: () => codex.run(() => requestPluginConversationBinding(bindingTarget)),
    detach: () => codex.run(() => detachPluginConversationBinding(bindingTarget)),
  };
}

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
  fixture.gate.armed = true;
  const request = fixture.refresh();
  onTestFinished(async () => {
    fixture.gate.release.resolve();
    await Promise.allSettled([request]);
  });

  const entered = awaitGateBeforeSettlement(
    fixture.gate.entered.promise,
    request,
    "Telegram write settled before registration",
  );
  await withinTest(entered, signal);

  expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(true);
  markPluginRegistryRetired(fixture.builder.registry);
  expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(false);
  fixture.gate.release.resolve();

  await expect(request).rejects.toThrow('Plugin "telegram" runtime is no longer active.');
  expect(await fixture.read()).toEqual(fixture.snapshot);
});
