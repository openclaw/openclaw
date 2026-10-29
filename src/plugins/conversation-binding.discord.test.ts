import { expectDefined } from "@openclaw/normalization-core";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, onTestFinished } from "vitest";
import { testing as sessionBindingTesting } from "../infra/outbound/session-binding-service.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type StoredDiscordBinding = {
  targetSessionKey: string;
  metadata?: Record<string, unknown>;
};

type DiscordBindingManager = {
  getByThreadId: (threadId: string) => StoredDiscordBinding | undefined;
  stop: () => Promise<void>;
};

type ThreadBindingTestHarness = {
  createTestThreadBindingManager: (params: {
    accountId?: string;
    persist?: boolean;
  }) => Promise<DiscordBindingManager>;
  installThreadBindingLifecycleTestHooks: () => void;
};

const {
  loadDiscordThreadBindingTestHarness,
  resetThreadBindingsForTests,
  unbindThreadBindingsBySessionKey,
} = await loadBundledPluginFacade<{
  loadDiscordThreadBindingTestHarness: () => Promise<ThreadBindingTestHarness>;
  resetThreadBindingsForTests: () => Promise<void>;
  unbindThreadBindingsBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
  }) => unknown[];
}>({ pluginId: "discord", artifactBasename: "test-api.js" });
const { setDiscordRuntime } = await loadBundledPluginFacade<{
  setDiscordRuntime: (runtime: PluginRuntime) => void;
}>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
const { createTestThreadBindingManager, installThreadBindingLifecycleTestHooks } =
  await loadDiscordThreadBindingTestHarness();
installThreadBindingLifecycleTestHooks();

const identity = {
  pluginId: "codex",
  pluginName: "Codex",
  pluginRoot: "/plugins/codex-a",
};
// A Discord DM binds the user conversation itself; no thread/channel lookup is needed.
const conversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "user:123",
};
const storeOptions = { namespace: "thread-bindings", maxEntries: 10_000 };
const storeAuthority = { assertCurrent() {} };

async function setup() {
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
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
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
  await discord.run(() => bindConversationNow({ identity, conversation, summary: "original" }));

  const observer = createPluginStateKeyedStoreV2ForTests<StoredDiscordBinding>(
    "discord",
    storeOptions,
    storeAuthority,
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
  const resolveBinding = () => getSessionBindingService().resolveByConversationAsync(conversation);
  return { discord, foreign, manager, restart, resolveBinding, stored, retire };
}

describe("Discord thread binding ownership across plugin instances", () => {
  it("persists a foreign-instance detach and keeps it gone after a restart", async () => {
    const { foreign, manager, restart, resolveBinding, stored } = await setup();

    const detached = await foreign.run(() =>
      detachPluginConversationBinding({
        pluginRoot: identity.pluginRoot,
        conversation,
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
    const { foreign, restart, resolveBinding, stored } = await setup();

    const rebound = await foreign.run(() =>
      requestPluginConversationBinding({
        ...identity,
        conversation,
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
    const { discord, foreign, restart, stored } = await setup();

    await foreign.run(() =>
      detachPluginConversationBinding({
        pluginRoot: identity.pluginRoot,
        conversation,
      }),
    );
    await discord.run(() =>
      bindConversationNow({
        identity,
        conversation: { ...conversation, conversationId: "user:456" },
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

  it("refuses a foreign plugin root without touching durable rows or memory", async () => {
    const { foreign, manager, stored } = await setup();
    const foreignIdentity = {
      pluginId: "codex-other",
      pluginName: "Codex Other",
      pluginRoot: "/plugins/codex-other",
    };

    const detached = await foreign.run(() =>
      detachPluginConversationBinding({
        pluginRoot: foreignIdentity.pluginRoot,
        conversation,
      }),
    );
    const rebound = await foreign.run(() =>
      requestPluginConversationBinding({
        ...foreignIdentity,
        conversation,
        binding: { summary: "stolen" },
      }),
    );

    expect(detached).toEqual({ removed: false });
    expect(rebound).toMatchObject({ status: "error" });
    expect(manager.getByThreadId("user:123")?.metadata).toMatchObject({ summary: "original" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);
  });

  it("refuses a retired Discord owner without publishing memory or changing rows", async () => {
    const { foreign, manager, retire, stored } = await setup();
    retire();

    await expect(
      foreign.run(() =>
        detachPluginConversationBinding({
          pluginRoot: identity.pluginRoot,
          conversation,
        }),
      ),
    ).rejects.toThrow(/no longer active/);

    expect(manager.getByThreadId("user:123")?.metadata).toMatchObject({ summary: "original" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);
  });

  it("refuses a retired owner through the synchronous compatibility path", async () => {
    const { manager, retire, stored } = await setup();
    const binding = manager.getByThreadId("user:123");
    expect(binding).toBeDefined();
    retire();

    expect(() =>
      unbindThreadBindingsBySessionKey({
        targetSessionKey: binding!.targetSessionKey,
        reason: "plugin-detach",
      }),
    ).toThrow(/no longer active/);

    expect(manager.getByThreadId("user:123")?.metadata).toMatchObject({ summary: "original" });
    expect(await stored()).toMatchObject([
      { key: "default:user:123", value: { metadata: { summary: "original" } } },
    ]);
  });
});
