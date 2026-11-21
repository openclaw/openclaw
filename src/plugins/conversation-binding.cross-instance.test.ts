import { expectDefined } from "@openclaw/normalization-core";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
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

type StoredDiscordBinding = {
  targetSessionKey: string;
  idleTimeoutMs?: number;
  metadata?: Record<string, unknown>;
};

type DiscordBindingManager = {
  getByThreadId: (threadId: string) => StoredDiscordBinding | undefined;
};

type DiscordThreadBindingTestHarness = {
  createTestThreadBindingManager: (params: {
    accountId?: string;
    persist?: boolean;
  }) => Promise<DiscordBindingManager>;
  installThreadBindingLifecycleTestHooks: () => void;
};

const { loadDiscordThreadBindingTestHarness, resetThreadBindingsForTests } =
  await loadBundledPluginFacade<{
    loadDiscordThreadBindingTestHarness: () => Promise<DiscordThreadBindingTestHarness>;
    resetThreadBindingsForTests: () => Promise<void>;
  }>({ pluginId: "discord", artifactBasename: "test-api.js" });
const {
  setDiscordRuntime,
  setThreadBindingIdleTimeoutBySessionKey,
  unbindThreadBindingsBySessionKey,
} = await loadBundledPluginFacade<{
  setDiscordRuntime: (runtime: PluginRuntime) => void;
  setThreadBindingIdleTimeoutBySessionKey: (params: {
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => unknown[];
  unbindThreadBindingsBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
  }) => unknown[];
}>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
const { createTestThreadBindingManager, installThreadBindingLifecycleTestHooks } =
  await loadDiscordThreadBindingTestHarness();

const discordIdentity = {
  pluginId: "codex",
  pluginName: "Codex",
  pluginRoot: "/plugins/codex-a",
};
// A Discord DM binds the user conversation itself; no thread/channel lookup is needed.
const discordConversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "user:123",
};
const discordStoreOptions = { namespace: "thread-bindings", maxEntries: 10_000 };
const discordStoreAuthority = { assertCurrent() {} };

describe("Discord thread binding ownership across plugin instances", () => {
  installThreadBindingLifecycleTestHooks();

  async function setupDiscordBinding() {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-discord-binding-runtime-owner-",
    });
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    const foreign = new PluginInstance("codex");
    const owners: Array<{ retire: () => void; dispose: () => Promise<unknown> }> = [];
    onTestFinished(async () => {
      await resetThreadBindingsForTests();
      for (const owner of owners) {
        owner.retire();
        await owner.dispose();
      }
      await foreign.dispose();
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      resetPluginStateStoreForTests();
      await state.cleanup();
    });

    // The manager is created by Discord's plugin instance, as channel startup does.
    const { createPluginRuntime } = await import("./runtime/index.js");
    const builder = createTestPluginRegistry(createPluginRuntime());
    const record = createPluginRecord({ id: "discord", origin: "bundled" });
    const api = builder.createApi(record, {
      config: { channels: { discord: {} } },
      registrationMode: "full",
    });
    const discord = expectDefined(getPluginInstance(record), "registered Discord instance");
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    let retired = false;
    const retire = () => {
      if (!retired) {
        retired = true;
        markPluginRegistryRetired(builder.registry);
      }
    };
    owners.push({
      retire,
      dispose: () => discord.dispose(),
    });
    discord.run(() => setDiscordRuntime(api.runtime));

    const manager = await discord.run(() =>
      createTestThreadBindingManager({ accountId: "default", persist: true }),
    );
    await discord.run(() =>
      bindConversationNow({
        identity: discordIdentity,
        conversation: discordConversation,
        summary: "original",
      }),
    );

    const observer = createPluginStateKeyedStoreV2ForTests<StoredDiscordBinding>(
      "discord",
      discordStoreOptions,
      discordStoreAuthority,
    );
    const stored = () => observer.entries();
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);

    const restart = async () => {
      // A Gateway restart drops process memory; the state store keeps the durable rows.
      await resetThreadBindingsForTests();
      return await discord.run(() =>
        createTestThreadBindingManager({ accountId: "default", persist: true }),
      );
    };
    const resolveBinding = () =>
      getSessionBindingService().resolveByConversationAsync(discordConversation);
    return { discord, foreign, manager, restart, resolveBinding, stored, retire };
  }

  it("persists a foreign-instance detach and keeps it gone after a restart", async () => {
    const { foreign, manager, restart, resolveBinding, stored } = await setupDiscordBinding();

    const detached = await foreign.run(() =>
      detachPluginConversationBinding({
        pluginRoot: discordIdentity.pluginRoot,
        conversation: discordConversation,
      }),
    );

    expect(detached).toEqual({ removed: true });
    expect(manager.getByThreadId("user:123")).toBeUndefined();
    expect(await stored()).toEqual([]);

    const restarted = await restart();
    expect(restarted.getByThreadId("user:123")).toBeUndefined();
    expect(await resolveBinding()).toBeNull();
  });

  it("persists a foreign-instance rebind and restores the new binding after a restart", async () => {
    const { foreign, restart, resolveBinding, stored } = await setupDiscordBinding();

    const rebound = await foreign.run(() =>
      requestPluginConversationBinding({
        ...discordIdentity,
        conversation: discordConversation,
        binding: { summary: "refreshed" },
      }),
    );

    expect(rebound).toMatchObject({ status: "bound" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "refreshed" } } },
    ]);

    const restarted = await restart();
    expect(restarted.getByThreadId("user:123")?.metadata).toMatchObject({
      summary: "refreshed",
    });
    expect((await resolveBinding())?.metadata).toMatchObject({ summary: "refreshed" });
  });

  it("keeps a channel-owned binding written after a foreign-instance change", async () => {
    const { discord, foreign, restart, stored } = await setupDiscordBinding();

    await foreign.run(() =>
      detachPluginConversationBinding({
        pluginRoot: discordIdentity.pluginRoot,
        conversation: discordConversation,
      }),
    );
    await discord.run(() =>
      bindConversationNow({
        identity: discordIdentity,
        conversation: { ...discordConversation, conversationId: "user:456" },
        summary: "second",
      }),
    );

    expect(await stored()).toMatchObject([
      { key: "default:user:456", value: { metadata: { summary: "second" } } },
    ]);
    const restarted = await restart();
    expect(restarted.getByThreadId("user:456")?.metadata).toMatchObject({ summary: "second" });
    expect(restarted.getByThreadId("user:123")).toBeUndefined();
  });

  it("refuses a retired Discord owner without publishing memory or changing rows", async () => {
    const { foreign, manager, retire, stored } = await setupDiscordBinding();
    retire();

    await expect(
      foreign.run(() =>
        detachPluginConversationBinding({
          pluginRoot: discordIdentity.pluginRoot,
          conversation: discordConversation,
        }),
      ),
    ).rejects.toThrow(/no longer active/);

    expect(manager.getByThreadId("user:123")?.metadata).toMatchObject({ summary: "original" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);
  });

  it("refuses a retired owner through the synchronous compatibility path", async () => {
    const { manager, retire, stored } = await setupDiscordBinding();
    const binding = expectDefined(manager.getByThreadId("user:123"), "created Discord binding");
    retire();

    expect(() =>
      unbindThreadBindingsBySessionKey({
        targetSessionKey: binding.targetSessionKey,
        reason: "plugin-detach",
      }),
    ).toThrow(/no longer active/);

    expect(manager.getByThreadId("user:123")?.metadata).toMatchObject({ summary: "original" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);
  });

  it("refuses a retired owner through the synchronous session idle-timeout path", async () => {
    const { manager, retire, stored } = await setupDiscordBinding();
    const binding = expectDefined(manager.getByThreadId("user:123"), "created Discord binding");
    const originalIdleTimeoutMs = binding.idleTimeoutMs;
    const originalRows = await stored();
    retire();

    expect(() =>
      setThreadBindingIdleTimeoutBySessionKey({
        targetSessionKey: binding.targetSessionKey,
        idleTimeoutMs: (originalIdleTimeoutMs ?? 0) + 1,
      }),
    ).toThrow(/no longer active/);

    expect(manager.getByThreadId("user:123")?.idleTimeoutMs).toBe(originalIdleTimeoutMs);
    expect(await stored()).toEqual(originalRows);
  });
});
