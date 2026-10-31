import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { bindConversationNow, detachPluginConversationBinding } from "./conversation-binding.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type Binding = { targetSessionKey: string; idleTimeoutMs?: number; lastActivityAt: number };
type Manager = {
  getByThreadId(threadId: string): Binding | undefined;
  touchThread(params: { threadId: string; at: number }): Promise<Binding | null>;
  unbindThread(params: { threadId: string }): Promise<Binding | null>;
  stop(): Promise<void>;
};
const { loadDiscordThreadBindingTestHarness, resetThreadBindingsForTests } =
  await loadBundledPluginFacade<{
    loadDiscordThreadBindingTestHarness: () => Promise<{
      createTestThreadBindingManager: (params: {
        accountId: string;
        persist: boolean;
      }) => Promise<Manager>;
      installThreadBindingLifecycleTestHooks: () => void;
    }>;
    resetThreadBindingsForTests: () => Promise<void>;
  }>({ pluginId: "discord", artifactBasename: "test-api.js" });
const { createTestThreadBindingManager, installThreadBindingLifecycleTestHooks } =
  await loadDiscordThreadBindingTestHarness();
const { setDiscordRuntime, setThreadBindingIdleTimeoutBySessionKeyAsync } =
  await loadBundledPluginFacade<{
    setDiscordRuntime: (runtime: PluginRuntime) => void;
    setThreadBindingIdleTimeoutBySessionKeyAsync: (params: {
      targetSessionKey: string;
      idleTimeoutMs: number;
    }) => Promise<Binding[]>;
  }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
installThreadBindingLifecycleTestHooks();

const identity = { pluginId: "codex", pluginName: "Codex", pluginRoot: "/plugins/codex-handoff" };
const conversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "user:handoff",
};
const targetSessionKey = "agent:main:plugin:codex:handoff";

async function setup() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-discord-handoff-",
  });
  const owners: Array<{ retire(): void; dispose(): Promise<unknown> }> = [];
  onTestFinished(async () => {
    await resetThreadBindingsForTests();
    for (const owner of owners) {
      owner.retire();
      await owner.dispose();
    }
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  const { createPluginRuntime } = await import("./runtime/index.js");
  const createOwner = () => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "discord", origin: "bundled" });
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    const instance = expectDefined(getPluginInstance(record), "Discord instance");
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    instance.run(() => setDiscordRuntime(api.runtime));
    const owner = {
      instance,
      retire: () => markPluginRegistryRetired(builder.registry),
      dispose: () => instance.dispose(),
      start: () =>
        instance.run(() => createTestThreadBindingManager({ accountId: "default", persist: true })),
      bind: () =>
        instance.run(() => bindConversationNow({ identity, conversation, targetSessionKey })),
      idle: (idleTimeoutMs: number) =>
        instance.run(() =>
          setThreadBindingIdleTimeoutBySessionKeyAsync({ targetSessionKey, idleTimeoutMs }),
        ),
    };
    owners.push(owner);
    return owner;
  };
  const owner = createOwner();
  const manager = await owner.start();
  await owner.bind();
  const observer = createPluginStateKeyedStoreV2ForTests<Binding>(
    "discord",
    { namespace: "thread-bindings", maxEntries: 10_000 },
    { assertCurrent() {} },
  );
  return { owner, manager, createOwner, stored: () => observer.entries() };
}

describe("Discord manager retirement handoff", () => {
  it("refuses candidate-owned writes through a retained owner until an explicit handoff", async () => {
    const { owner, manager, createOwner, stored } = await setup();
    const candidate = createOwner();
    expect(await candidate.start()).toBe(manager);
    const snapshot = await stored();
    owner.retire();
    await expect(candidate.idle(60_000)).rejects.toMatchObject({
      code: "PLUGIN_STATE_RUNTIME_INACTIVE",
    });
    expect(await stored()).toEqual(snapshot);
    expect(await candidate.start()).not.toBe(manager);
    await expect(candidate.idle(60_000)).resolves.toMatchObject([{ idleTimeoutMs: 60_000 }]);
    expect(await stored()).toMatchObject([{ value: { idleTimeoutMs: 60_000 } }]);
  });

  it("gives a replacement provider its own manager before old lifecycle cleanup finishes", async () => {
    const { owner, manager, createOwner, stored } = await setup();
    owner.retire();
    const candidate = createOwner();
    const replacement = await candidate.start();
    expect(replacement).not.toBe(manager);

    await candidate.bind();
    await expect(candidate.idle(60_000)).resolves.toMatchObject([{ idleTimeoutMs: 60_000 }]);
    expect(await stored()).toMatchObject([{ value: { idleTimeoutMs: 60_000 } }]);
    await expect(manager.unbindThread({ threadId: conversation.conversationId })).rejects.toThrow();

    // Delayed cleanup must not unregister the replacement's adapter or manager.
    await manager.stop();
    expect(await candidate.start()).toBe(replacement);
    await candidate.bind();
    const at = Date.now() + 30_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    onTestFinished(() => clock.mockRestore());
    await expect(
      candidate.instance.run(() =>
        replacement.touchThread({ threadId: conversation.conversationId, at }),
      ),
    ).resolves.toMatchObject({ lastActivityAt: at });
    expect(await stored()).toMatchObject([{ value: { lastActivityAt: at } }]);
    await expect(
      candidate.instance.run(() =>
        detachPluginConversationBinding({ pluginRoot: identity.pluginRoot, conversation }),
      ),
    ).resolves.toEqual({ removed: true });
    expect(await stored()).toEqual([]);
  });

  it("does not replace a retired owner with an inactive candidate", async () => {
    const { owner, manager, createOwner, stored } = await setup();
    const snapshot = await stored();
    owner.retire();
    const candidate = createOwner();
    const pending = candidate.instance.run(() => {
      candidate.retire();
      return createTestThreadBindingManager({ accountId: "default", persist: true });
    });
    await expect(pending).rejects.toMatchObject({
      code: "PLUGIN_STATE_RUNTIME_INACTIVE",
    });
    expect(await stored()).toEqual(snapshot);
    await manager.stop();
  });
});
