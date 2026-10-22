import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionEntryAsync,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { capturePluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type StoredDiscordBinding = {
  targetSessionKey: string;
  metadata?: Record<string, unknown>;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};
type DiscordBindingManager = {
  getByThreadId: (threadId: string) => StoredDiscordBinding | undefined;
  bindTarget: (params: {
    threadId: string;
    channelId: string;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => Promise<StoredDiscordBinding | null>;
  unbindThread: (params: { threadId: string }) => Promise<StoredDiscordBinding | null>;
  notifyUnbound: (record: StoredDiscordBinding, params: { sendFarewell?: boolean }) => void;
  touchThread: (params: { threadId: string; at?: number }) => Promise<StoredDiscordBinding | null>;
  touchThreadSync: (
    params: Parameters<DiscordBindingManager["touchThread"]>[0],
  ) => StoredDiscordBinding | null;
  stop: () => Promise<void>;
};
type SessionUnbindParams = { targetSessionKey: string; sendFarewell?: boolean };
type IdleUpdateParams = { targetSessionKey: string; idleTimeoutMs: number };
type MaxAgeUpdateParams = { targetSessionKey: string; maxAgeMs: number };

const { loadDiscordThreadBindingTestHarness, resetThreadBindingsForTests } =
  await loadBundledPluginFacade<{
    loadDiscordThreadBindingTestHarness: () => Promise<{
      createTestThreadBindingManager: (params: {
        accountId: string;
        persist: boolean;
      }) => Promise<DiscordBindingManager>;
      installThreadBindingLifecycleTestHooks: () => void;
    }>;
    resetThreadBindingsForTests: () => Promise<void>;
  }>({ pluginId: "discord", artifactBasename: "test-api.js" });
const { DiscordThreadDeleteListener } = await loadBundledPluginFacade<{
  DiscordThreadDeleteListener: new (
    cfg: OpenClawConfig,
    accountId: string,
    logger: ReturnType<typeof createSubsystemLogger>,
  ) => { handle: (data: { id: string }) => Promise<void> };
}>({ pluginId: "discord", artifactBasename: "test-api.js" });
const { createTestThreadBindingManager, installThreadBindingLifecycleTestHooks } =
  await loadDiscordThreadBindingTestHarness();
const {
  setDiscordRuntime,
  unbindThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKeyAsync,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKey,
  setThreadBindingMaxAgeBySessionKeyAsync,
} = await loadBundledPluginFacade<{
  setDiscordRuntime: (runtime: PluginRuntime) => void;
  unbindThreadBindingsBySessionKey: (params: SessionUnbindParams) => StoredDiscordBinding[];
  unbindThreadBindingsBySessionKeyAsync: (
    params: SessionUnbindParams,
  ) => Promise<StoredDiscordBinding[]>;
  setThreadBindingIdleTimeoutBySessionKey: (params: IdleUpdateParams) => StoredDiscordBinding[];
  setThreadBindingIdleTimeoutBySessionKeyAsync: (
    params: IdleUpdateParams,
  ) => Promise<StoredDiscordBinding[]>;
  setThreadBindingMaxAgeBySessionKey: (params: MaxAgeUpdateParams) => StoredDiscordBinding[];
  setThreadBindingMaxAgeBySessionKeyAsync: (
    params: MaxAgeUpdateParams,
  ) => Promise<StoredDiscordBinding[]>;
}>({ pluginId: "discord", artifactBasename: "runtime-api.js" });

installThreadBindingLifecycleTestHooks();

const identity = { pluginId: "codex", pluginName: "Codex", pluginRoot: "/plugins/codex-a" };
const conversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "thread-1",
  parentConversationId: "parent-1",
};

const persistenceAvailable = () =>
  asOptionalRecord(readGlobalSingleton(Symbol.for("openclaw.discordThreadBindingsState")))
    ?.persistenceAvailable;

async function setup(persist = true) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-discord-binding-owner-",
  });
  const foreign = new PluginInstance("codex");
  const owners: Array<{ retire(): void; dispose(): Promise<unknown> }> = [];
  onTestFinished(async () => {
    await resetThreadBindingsForTests();
    for (const owner of owners) {
      owner.retire();
      await owner.dispose();
    }
    await foreign.dispose();
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
    const instance = expectDefined(getPluginInstance(record), "Discord registry instance");
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    instance.run(() => setDiscordRuntime(api.runtime));
    const owner = {
      instance,
      retire: () => markPluginRegistryRetired(builder.registry),
      revoke: () => revokePluginRecord(builder.registry, record),
      dispose: () => instance.dispose(),
      start: (accountId = "default", persistence = persist) =>
        instance.run(() => createTestThreadBindingManager({ accountId, persist: persistence })),
    };
    owners.push(owner);
    return owner;
  };
  const owner = createOwner();
  const manager = await owner.start();
  await owner.instance.run(() =>
    bindConversationNow({ identity, conversation, summary: "original" }),
  );
  // Observe durable rows even after retirement. The manager uses real registry authority.
  const observer = createPluginStateKeyedStoreV2ForTests<StoredDiscordBinding>(
    "discord",
    { namespace: "thread-bindings", maxEntries: 10_000 },
    { assertCurrent() {} },
  );
  const stored = () => observer.entries();
  const snapshot = await stored();
  expect(snapshot).toMatchObject(
    persist ? [{ key: "default:thread-1", value: { metadata: { summary: "original" } } }] : [],
  );
  const refresh = (summary: string, accountId = "default") =>
    foreign.run(() =>
      requestPluginConversationBinding({
        ...identity,
        conversation: { ...conversation, accountId },
        binding: { summary },
      }),
    );
  return { state, foreign, owner, manager, createOwner, stored, snapshot, refresh };
}

describe("Discord binding runtime ownership", () => {
  it("refuses retired touches with a bound operation source without disabling persistence", async () => {
    const { state, foreign, owner, manager, stored, snapshot } = await setup();
    await state.writeJson("operation-source/package.json", { name: "discord", type: "module" });
    const source = await state.writeText("operation-source/index.ts", "");
    const cache = createPluginCache();
    onTestFinished(async () => {
      expect((await retirePluginCache(cache)).failures).toEqual([]);
    });
    withPluginCache(cache, () =>
      bindPluginInstanceModuleLoader({
        instance: owner.instance,
        rootDir: state.statePath("operation-source"),
        source,
        origin: "config",
      }),
    );
    expect(capturePluginStateOperationModuleSource(owner.instance, () => {})).toBeDefined();
    const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
    owner.retire();
    const clock = vi.spyOn(Date, "now");
    onTestFinished(() => clock.mockRestore());

    for (const elapsed of [1_000, 30_000]) {
      const at = original.lastActivityAt + elapsed;
      clock.mockReturnValue(at);
      await expect
        .soft(foreign.run(() => manager.touchThread({ threadId: "thread-1", at })))
        .resolves.toBeNull();
      expect.soft(manager.getByThreadId("thread-1")).toEqual(original);
      expect.soft(persistenceAvailable()).toBe(true);
      expect(await stored()).toEqual(snapshot);
    }
  });

  it.each(
    (["throttled", "off", "unavailable"] as const).flatMap((persistence) =>
      [
        "async touch",
        "sync touch",
        "core touch",
        ...(persistence === "throttled"
          ? []
          : ["async update", "sync update", "async unbind", "sync unbind", "bind"]),
      ].flatMap((operation) =>
        (["active", "retired"] as const).map((authority) => ({
          persistence,
          operation,
          authority,
        })),
      ),
    ),
  )(
    "guards $operation with $persistence persistence and $authority owner",
    async ({ persistence, operation, authority }) => {
      const { foreign, owner, manager, createOwner, stored, snapshot } = await setup(
        persistence !== "off",
      );
      const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
      const binding = expectDefined(
        await getSessionBindingService().resolveByConversationAsync(conversation),
        "seed session binding",
      );
      if (persistence === "unavailable") {
        const shared = expectDefined(
          asOptionalRecord(readGlobalSingleton(Symbol.for("openclaw.discordThreadBindingsState"))),
          "shared binding state",
        );
        shared.persistenceAvailable = false;
      }
      if (authority === "retired") {
        owner.retire();
      }
      const at = original.lastActivityAt + 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      onTestFinished(() => clock.mockRestore());
      const result = foreign.run(async () => {
        switch (operation) {
          case "async touch":
            return manager.touchThread({ threadId: "thread-1", at });
          case "sync touch":
            return manager.touchThreadSync({ threadId: "thread-1", at });
          case "core touch":
            return getSessionBindingService().touchAsync(
              binding.bindingId,
              undefined,
              binding.conversation,
            );
          case "async update":
          case "sync update":
            return (
              operation === "sync update"
                ? setThreadBindingIdleTimeoutBySessionKey
                : setThreadBindingIdleTimeoutBySessionKeyAsync
            )({
              targetSessionKey: original.targetSessionKey,
              idleTimeoutMs: 45_000,
            });
          case "async unbind":
          case "sync unbind":
            return (
              operation === "sync unbind"
                ? unbindThreadBindingsBySessionKey
                : unbindThreadBindingsBySessionKeyAsync
            )({
              targetSessionKey: original.targetSessionKey,
              sendFarewell: false,
            });
          case "bind":
            return manager.bindTarget({
              threadId: "thread-1",
              channelId: "parent-1",
              targetSessionKey: original.targetSessionKey,
              metadata: { summary: "memory-only replacement" },
            });
          default:
            throw new Error("Unsupported memory-only mutation");
        }
      });
      if (authority === "retired" && ["async update", "async unbind", "bind"].includes(operation)) {
        await expect.soft(result).rejects.toMatchObject({ code: "PLUGIN_STATE_RUNTIME_INACTIVE" });
      } else if (authority === "retired" && operation !== "core touch") {
        await expect
          .soft(result)
          .resolves.toEqual(
            operation.startsWith("sync ") && !operation.endsWith("touch") ? [] : null,
          );
      } else {
        await result;
      }
      const after = manager.getByThreadId("thread-1");
      if (authority === "retired") {
        expect.soft(after).toEqual(original);
      } else if (operation.endsWith("unbind")) {
        expect.soft(after).toBeUndefined();
      } else {
        expect
          .soft(after)
          .toMatchObject(
            operation.endsWith("touch")
              ? { lastActivityAt: at }
              : operation.endsWith("update")
                ? { idleTimeoutMs: 45_000 }
                : { metadata: { summary: "memory-only replacement" } },
          );
      }
      expect.soft(persistenceAvailable()).toBe(persistence !== "unavailable");
      expect(await stored()).toEqual(snapshot);
      await manager.stop();
      owner.retire();
      const replacement = await createOwner().start("default", true);
      expect(replacement.getByThreadId("thread-1")).toEqual(
        authority === "retired" ? original : after,
      );
    },
  );

  it("keeps a foreign-instance detach removed after manager restart", async () => {
    const { foreign, owner, manager, stored } = await setup();
    await expect(
      foreign.run(() =>
        detachPluginConversationBinding({ pluginRoot: identity.pluginRoot, conversation }),
      ),
    ).resolves.toEqual({ removed: true });
    expect(manager.getByThreadId("thread-1")).toBeUndefined();
    expect(await stored()).toEqual([]);
    await resetThreadBindingsForTests();
    await owner.start();
    expect(await getSessionBindingService().resolveByConversationAsync(conversation)).toBeNull();
  });

  it("persists a foreign-instance rebind and subsequent channel-owned binding", async () => {
    const { owner, stored, refresh } = await setup();
    expect(await refresh("refreshed")).toMatchObject({ status: "bound" });
    await owner.instance.run(() =>
      bindConversationNow({
        identity,
        conversation: { ...conversation, conversationId: "thread-2" },
        summary: "second",
      }),
    );
    expect(await stored()).toMatchObject([
      { key: "default:thread-1", value: { metadata: { summary: "refreshed" } } },
      { key: "default:thread-2", value: { metadata: { summary: "second" } } },
    ]);
  });

  it.each(["async", "sync"] as const)(
    "persists %s activity from a foreign instance",
    async (mode) => {
      const { foreign, manager, stored } = await setup();
      const at = Date.now() + 30_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      try {
        await foreign.run(() =>
          mode === "sync"
            ? manager.touchThreadSync({ threadId: "thread-1", at })
            : manager.touchThread({ threadId: "thread-1", at }),
        );
        expect(await stored()).toMatchObject([{ value: { lastActivityAt: at } }]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["async", "sync"] as const)(
    "persists %s session-wide updates and unbinds",
    async (mode) => {
      const { foreign, manager, stored } = await setup();
      const targetSessionKey = expectDefined(
        manager.getByThreadId("thread-1"),
        "seed binding",
      ).targetSessionKey;
      await foreign.run(() =>
        (mode === "sync"
          ? setThreadBindingIdleTimeoutBySessionKey
          : setThreadBindingIdleTimeoutBySessionKeyAsync)({
          targetSessionKey,
          idleTimeoutMs: 45_000,
        }),
      );
      expect(await stored()).toMatchObject([{ value: { idleTimeoutMs: 45_000 } }]);
      await foreign.run(() =>
        (mode === "sync"
          ? unbindThreadBindingsBySessionKey
          : unbindThreadBindingsBySessionKeyAsync)({ targetSessionKey, sendFarewell: false }),
      );
      expect(await stored()).toEqual([]);
    },
  );

  it("does not replace a live manager's runtime during candidate lookup", async () => {
    const { manager, createOwner, stored, refresh } = await setup();
    const candidate = createOwner();
    expect(await candidate.start()).toBe(manager);
    candidate.retire();
    await refresh("original owner");
    expect(await stored()).toMatchObject([{ value: { metadata: { summary: "original owner" } } }]);
  });

  it("does not let a retired manager borrow an active candidate's runtime", async () => {
    const { owner, manager, createOwner, stored, snapshot, refresh } = await setup();
    const candidate = createOwner();
    expect(await candidate.start()).toBe(manager);
    owner.retire();
    await expect(refresh("retired write")).rejects.toMatchObject({
      code: "PLUGIN_STATE_RUNTIME_INACTIVE",
    });
    expect(await stored()).toEqual(snapshot);
  });

  it.each(["unbindThread", "bindTarget", "session update"] as const)(
    "does not report success for refused %s before manager shutdown",
    async (operation) => {
      const { foreign, owner, manager, stored, snapshot } = await setup();
      const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
      const notifyUnbound = vi.spyOn(manager, "notifyUnbound");
      owner.retire();
      const result = foreign.run(() => {
        if (operation === "unbindThread") {
          return manager.unbindThread({ threadId: "thread-1" });
        }
        if (operation === "bindTarget") {
          return manager.bindTarget({
            threadId: "thread-1",
            channelId: "parent-1",
            targetSessionKey: original.targetSessionKey,
            metadata: { summary: "refused replacement" },
          });
        }
        return setThreadBindingIdleTimeoutBySessionKeyAsync({
          targetSessionKey: original.targetSessionKey,
          idleTimeoutMs: 45_000,
        });
      });
      await expect.soft(result).rejects.toMatchObject({ code: "PLUGIN_STATE_RUNTIME_INACTIVE" });
      expect.soft(notifyUnbound).not.toHaveBeenCalled();
      expect.soft(manager.getByThreadId("thread-1")).toEqual(original);
      expect.soft(persistenceAvailable()).toBe(true);
      expect(await stored()).toEqual(snapshot);
    },
  );

  it("keeps core activity touches best effort while the owner is retired before stop", async () => {
    const { manager, owner, stored, snapshot } = await setup();
    const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
    const binding = expectDefined(
      await getSessionBindingService().resolveByConversationAsync(conversation),
      "seed session binding",
    );
    owner.retire();
    // Past the 15 s persist interval, so the touch opens the store.
    const at = Date.now() + 30_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await getSessionBindingService().touchAsync(
        binding.bindingId,
        undefined,
        binding.conversation,
      );
    } finally {
      clock.mockRestore();
    }
    expect(persistenceAvailable()).toBe(true);
    expect(manager.getByThreadId("thread-1")).toEqual(original);
    expect(await stored()).toEqual(snapshot);
  });

  it("closes the deleted thread's sessions while the owner is retired before stop", async () => {
    const { manager, owner, stored, snapshot } = await setup();
    const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
    const thread = {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:parent-1:thread:thread-1",
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await upsertSessionEntry({
      ...thread,
      entry: { sessionId: "thread-session", updatedAt: 1_000 },
    });
    expect(await getSessionEntryAsync(thread)).toMatchObject({ sessionId: "thread-session" });
    const logger = createSubsystemLogger("discord/test-thread-delete");
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {});
    onTestFinished(() => logError.mockRestore());
    owner.retire();
    await new DiscordThreadDeleteListener({}, "default", logger).handle({ id: "thread-1" });
    expect.soft(await getSessionEntryAsync(thread)).toBeUndefined();
    expect.soft(logError).not.toHaveBeenCalled();
    expect.soft(persistenceAvailable()).toBe(true);
    expect.soft(manager.getByThreadId("thread-1")).toEqual(original);
    expect(await stored()).toEqual(snapshot);
  });

  const mutations = [
    { mode: "sync", operation: "touch" },
    { mode: "async", operation: "touch" },
    { mode: "sync", operation: "idle timeout" },
    { mode: "async", operation: "idle timeout" },
    { mode: "sync", operation: "max age" },
    { mode: "async", operation: "max age" },
    { mode: "sync", operation: "unbind" },
    { mode: "async", operation: "unbind" },
    { mode: "async", operation: "rebind" },
    { mode: "async", operation: "detach" },
  ] as const;
  it.each(
    mutations.flatMap((mutation) =>
      (["active", "retired-before-stop", "stopped"] as const).map((state) => ({
        mode: mutation.mode,
        operation: mutation.operation,
        state,
      })),
    ),
  )("guards $mode $operation while $state", async ({ mode, operation, state }) => {
    const { foreign, owner, manager, stored, snapshot, refresh } = await setup();
    const targetSessionKey = expectDefined(
      manager.getByThreadId("thread-1"),
      "seed binding",
    ).targetSessionKey;
    if (state !== "active") {
      owner.retire();
    }
    if (state === "stopped") {
      await manager.stop();
    }
    const at = Date.now() + 30_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      const mutate = async () => {
        switch (operation) {
          case "touch":
            return mode === "sync"
              ? manager.touchThreadSync({ threadId: "thread-1", at })
              : manager.touchThread({ threadId: "thread-1", at });
          case "idle timeout":
            return (
              mode === "sync"
                ? setThreadBindingIdleTimeoutBySessionKey
                : setThreadBindingIdleTimeoutBySessionKeyAsync
            )({
              targetSessionKey,
              idleTimeoutMs: 45_000,
            });
          case "max age":
            return (
              mode === "sync"
                ? setThreadBindingMaxAgeBySessionKey
                : setThreadBindingMaxAgeBySessionKeyAsync
            )({
              targetSessionKey,
              maxAgeMs: 90_000,
            });
          case "unbind":
            return (
              mode === "sync"
                ? unbindThreadBindingsBySessionKey
                : unbindThreadBindingsBySessionKeyAsync
            )({ targetSessionKey, sendFarewell: false });
          case "rebind":
            return refresh("guarded refresh");
          case "detach":
            return detachPluginConversationBinding({
              pluginRoot: identity.pluginRoot,
              conversation,
            });
          default:
            throw new Error("Unsupported binding mutation");
        }
      };
      const result = foreign.run(mutate);
      if (state === "stopped" && operation === "touch") {
        await expect(result).rejects.toThrow(/stopping|was retired/);
      } else if (state === "retired-before-stop" && mode === "async" && operation === "touch") {
        await expect(result).resolves.toBeNull();
      } else if (state === "retired-before-stop" && mode === "async") {
        await expect(result).rejects.toMatchObject({ code: "PLUGIN_STATE_RUNTIME_INACTIVE" });
      } else {
        await result;
      }
      if (state !== "active") {
        expect(await stored()).toEqual(snapshot);
      } else if (operation === "unbind" || operation === "detach") {
        expect(await stored()).toEqual([]);
      } else {
        const expected =
          operation === "touch"
            ? { lastActivityAt: at }
            : operation === "idle timeout"
              ? { idleTimeoutMs: 45_000 }
              : operation === "max age"
                ? { maxAgeMs: 90_000 }
                : { metadata: { summary: "guarded refresh" } };
        expect(await stored()).toMatchObject([{ value: expected }]);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("captures the replacement runtime after the previous manager stops", async () => {
    const { owner, manager, createOwner, stored, refresh } = await setup();
    await manager.stop();
    owner.retire();
    const replacement = await createOwner().start();
    expect(replacement).not.toBe(manager);
    await manager.stop();
    await expect(manager.touchThread({ threadId: "thread-1" })).rejects.toThrow("stopping");
    await refresh("replacement");
    expect(await stored()).toMatchObject([{ value: { metadata: { summary: "replacement" } } }]);
  });

  const persistenceMutations = ["sync update", "sync unbind", "async update"] as const;
  const mutatePersistence = (
    operation: (typeof persistenceMutations)[number],
    targetSessionKey: string,
  ) =>
    operation === "sync unbind"
      ? unbindThreadBindingsBySessionKey({ targetSessionKey, sendFarewell: false })
      : (operation === "sync update"
          ? setThreadBindingIdleTimeoutBySessionKey
          : setThreadBindingIdleTimeoutBySessionKeyAsync)({
          targetSessionKey,
          idleTimeoutMs: 45_000,
        });

  it.each([
    { authority: "retired", operation: "control" },
    ...(["retired", "revoked"] as const).flatMap((authority) =>
      persistenceMutations.map((operation) => ({ authority, operation })),
    ),
  ] as const)(
    "keeps replacement persistence after $authority $operation",
    async ({ authority, operation }) => {
      const { foreign, owner, manager, createOwner, stored, snapshot } = await setup();
      const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
      if (authority === "retired") {
        owner.retire();
      } else {
        owner.revoke();
      }
      if (operation !== "control") {
        const result = foreign.run(() => mutatePersistence(operation, original.targetSessionKey));
        if (operation === "async update") {
          await expect(result).rejects.toMatchObject({ code: "PLUGIN_STATE_RUNTIME_INACTIVE" });
        } else {
          await result;
        }
      }
      expect.soft(persistenceAvailable(), "after authority refusal").toBe(true);
      expect.soft(manager.getByThreadId("thread-1"), "refused memory write").toEqual(original);
      expect(await stored()).toEqual(snapshot);
      await manager.stop();
      const replacement = createOwner();
      await replacement.start();
      await replacement.instance.run(() =>
        bindConversationNow({
          identity,
          conversation: { ...conversation, conversationId: "thread-2" },
          summary: "replacement owner",
        }),
      );
      expect({ persistenceAvailable: persistenceAvailable(), rows: await stored() }).toMatchObject({
        persistenceAvailable: true,
        rows: [
          ...snapshot.map(({ key, value }) => ({ key, value })),
          { key: "default:thread-2", value: { metadata: { summary: "replacement owner" } } },
        ],
      });
    },
  );

  it.each(persistenceMutations)("keeps the storage failure fallback for %s", async (operation) => {
    const { state, foreign, manager, stored, snapshot } = await setup();
    const original = expectDefined(manager.getByThreadId("thread-1"), "seed binding");
    const db = openOpenClawStateDatabase({ env: state.env }).db;
    const removing = operation === "sync unbind";
    db.exec(`CREATE TRIGGER fail_discord_binding_write BEFORE ${removing ? "DELETE" : "INSERT"}
      ON plugin_state_entries WHEN ${removing ? "OLD" : "NEW"}.plugin_id = 'discord'
      BEGIN SELECT RAISE(ABORT, 'synthetic Discord storage failure'); END`);
    try {
      await foreign.run(() => mutatePersistence(operation, original.targetSessionKey));
      expect(persistenceAvailable()).toBe(false);
      if (removing) {
        expect(manager.getByThreadId("thread-1")).toBeUndefined();
      } else {
        expect(manager.getByThreadId("thread-1")).toMatchObject({ idleTimeoutMs: 45_000 });
      }
      expect(await stored()).toEqual(snapshot);
    } finally {
      db.exec("DROP TRIGGER fail_discord_binding_write");
    }
  });

  it("keeps overlapping accounts bound to their own runtime", async () => {
    const { createOwner, stored, refresh } = await setup();
    const second = createOwner();
    await second.start("second");
    await second.instance.run(() =>
      bindConversationNow({
        identity,
        conversation: { ...conversation, accountId: "second" },
        summary: "second account",
      }),
    );
    await refresh("second refreshed", "second");
    await refresh("first refreshed");
    second.retire();
    await refresh("first still active");
    expect(await stored()).toMatchObject([
      { key: "default:thread-1", value: { metadata: { summary: "first still active" } } },
      { key: "second:thread-1", value: { metadata: { summary: "second refreshed" } } },
    ]);
  });
});
