import { afterEach, describe, expect, it, vi } from "vitest";
import { revokePluginRecordLifecycleEpoch } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  dispatchChannelMessageAction,
  prepareExternalMessageActionTargetForResolution,
  shouldDeferExternalMessageActionTargetResolution,
} from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

const receipt = { content: [{ type: "text" as const, text: "delivered" }], details: { ok: true } };

afterEach(() => resetPluginRuntimeStateForTest());

describe("message action registration ownership", () => {
  it.each([true, false])(
    "uses only the selected scoped action capability (present=%s)",
    async (present) => {
      const handleRootAction = vi.fn(async () => receipt);
      const handleScopedAction = vi.fn(async () => receipt);
      const base = createChannelTestPluginBase({ id: "scoped-delivery" });
      const root = { ...base, actions: { handleAction: handleRootAction } };
      const scoped = {
        ...base,
        ...(present ? { actions: { handleAction: handleScopedAction } } : {}),
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", origin: "bundled", plugin: root }]),
      );
      const registry = createTestRegistry([
        { pluginId: "scoped", source: "scoped", origin: "config", plugin: scoped },
      ]);

      const result = await withPluginRuntimeRegistryScope(registry, () =>
        dispatchChannelMessageAction({
          cfg: {},
          channel: base.id,
          action: "send",
          params: { to: "recipient", message: "hello" },
        }),
      );

      expect(result).toEqual(present ? receipt : null);
      expect(handleRootAction).not.toHaveBeenCalled();
      expect(handleScopedAction).toHaveBeenCalledTimes(present ? 1 : 0);
    },
  );
  it("keeps scoped channel read authority external beside a bundled same-id registration", async () => {
    const handleRootAction = vi.fn(async () => receipt);
    const handleScopedAction = vi.fn(async () => receipt);
    const base = createChannelTestPluginBase({ id: "scoped-delivery" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "root",
          source: "root",
          origin: "bundled",
          plugin: {
            ...base,
            actions: { providerOwnedReadGates: true, handleAction: handleRootAction },
          },
        },
      ]),
    );
    const registry = createTestRegistry([
      {
        pluginId: "scoped",
        source: "scoped",
        origin: "config",
        plugin: {
          ...base,
          actions: { providerOwnedReadGates: true, handleAction: handleScopedAction },
        },
      },
    ]);
    const context = { cfg: {}, channel: base.id, action: "read", params: { to: "recipient" } };

    await withPluginRuntimeRegistryScope(registry, async () => {
      await expect(
        dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "delegated",
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleScopedAction).not.toHaveBeenCalled();
      expect(handleRootAction).not.toHaveBeenCalled();

      expect(
        await dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "direct-operator",
        }),
      ).toBe(receipt);
      expect(
        await dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "delegated",
          accountId: "ops",
          requesterAccountId: "ops",
          toolContext: { currentChannelProvider: base.id, currentChannelId: "recipient" },
        }),
      ).toBe(receipt);
      expect(handleScopedAction).toHaveBeenCalledTimes(2);
      expect(handleRootAction).not.toHaveBeenCalled();
    });
  });
});

describe("official channel delegated read provenance", () => {
  function registerChannel(options: {
    trustedOfficialInstall?: boolean;
    providerOwnedReadGates?: NonNullable<ChannelPlugin["actions"]>["providerOwnedReadGates"];
  }) {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "official-read-owner",
      origin: "global",
      trustedOfficialInstall: options.trustedOfficialInstall,
    });
    const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => receipt);
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "official-read-channel" }),
      actions: {
        describeMessageTool: () => ({ actions: ["read", "search"] }),
        providerOwnedReadGates: options.providerOwnedReadGates,
        handleAction,
      },
    };
    owner.registry.plugins.push(record);
    const register = () => {
      owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
      setActivePluginRegistry(owner.registry);
    };
    register();
    return { owner, record, plugin, handleAction, register };
  }

  const context: ChannelMessageActionContext = {
    cfg: {},
    channel: "official-read-channel",
    action: "read",
    params: { channelId: "configured-other" },
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "official-read-channel", currentChannelId: "current" },
  };

  it.each([
    {
      name: "official full declaration",
      trustedOfficialInstall: true,
      providerOwnedReadGates: true,
      allowed: true,
    },
    {
      name: "official read declaration",
      trustedOfficialInstall: true,
      providerOwnedReadGates: ["read"],
      allowed: true,
    },
    {
      name: "official undeclared action",
      trustedOfficialInstall: true,
      providerOwnedReadGates: ["search"],
      allowed: false,
    },
    {
      name: "official missing declaration",
      trustedOfficialInstall: true,
      providerOwnedReadGates: undefined,
      allowed: false,
    },
    {
      name: "untrusted self declaration",
      trustedOfficialInstall: false,
      providerOwnedReadGates: true,
      allowed: false,
    },
    {
      name: "legacy missing provenance",
      trustedOfficialInstall: undefined,
      providerOwnedReadGates: true,
      allowed: false,
    },
  ] as const)("enforces registered $name across conversations", async (testCase) => {
    const { handleAction } = registerChannel(testCase);
    if (testCase.allowed) {
      expect(shouldDeferExternalMessageActionTargetResolution(context)).toBe(false);
      expect(prepareExternalMessageActionTargetForResolution(context)).toEqual(context.params);
      expect(await dispatchChannelMessageAction(context)).toBe(receipt);
      expect(handleAction).toHaveBeenCalledOnce();
    } else {
      expect(shouldDeferExternalMessageActionTargetResolution(context)).toBe(true);
      expect(() => prepareExternalMessageActionTargetForResolution(context)).toThrow(
        "requires the exact current conversation and account",
      );
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "requires the exact current conversation and account",
      );
      expect(handleAction).not.toHaveBeenCalled();
    }
  });

  it("preserves provider account and channel rejection for a trusted official adapter", async () => {
    const { handleAction } = registerChannel({
      trustedOfficialInstall: true,
      providerOwnedReadGates: true,
    });
    handleAction.mockImplementation(async (ctx) => {
      if (ctx.accountId !== "default" || ctx.params.channelId !== "configured-other") {
        throw new Error("provider denied account or channel");
      }
      return receipt;
    });
    for (const denied of [
      { ...context, accountId: "different" },
      { ...context, params: { channelId: "not-configured" } },
    ]) {
      await expect(dispatchChannelMessageAction(denied)).rejects.toThrow(
        "provider denied account or channel",
      );
    }
    expect(await dispatchChannelMessageAction(context)).toBe(receipt);
  });

  it.each([false, undefined])(
    "drops prior official authority when the same owner re-registers with trust=%s",
    async (trust) => {
      const fixture = registerChannel({
        trustedOfficialInstall: true,
        providerOwnedReadGates: true,
      });
      expect(await dispatchChannelMessageAction(context)).toBe(receipt);
      fixture.handleAction.mockClear();
      fixture.record.trustedOfficialInstall = trust;
      fixture.register();
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "requires the exact current conversation and account",
      );
      expect(fixture.handleAction).not.toHaveBeenCalled();
    },
  );

  it("does not borrow official trust from the root registry for a scoped same-id plugin", async () => {
    const scoped = registerChannel({ trustedOfficialInstall: false, providerOwnedReadGates: true });
    const root = registerChannel({ trustedOfficialInstall: true, providerOwnedReadGates: true });
    await withPluginRuntimeRegistryScope(scoped.owner.registry, async () => {
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "requires the exact current conversation and account",
      );
    });
    expect(scoped.handleAction).not.toHaveBeenCalled();
    expect(root.handleAction).not.toHaveBeenCalled();
    expect(await dispatchChannelMessageAction(context)).toBe(receipt);
  });

  it("ignores official trust claims in plugin payloads and tool arguments", async () => {
    const fixture = registerChannel({ providerOwnedReadGates: true });
    Object.assign(fixture.plugin, { trustedOfficialInstall: true });
    fixture.register();
    await expect(
      dispatchChannelMessageAction({
        ...context,
        params: { ...context.params, trustedOfficialInstall: true, pluginOrigin: "bundled" },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it("does not borrow root official read authority when the scoped registry lacks the channel", async () => {
    const root = registerChannel({ trustedOfficialInstall: true, providerOwnedReadGates: true });
    await withPluginRuntimeRegistryScope(createTestRegistry([]), async () => {
      expect(shouldDeferExternalMessageActionTargetResolution(context)).toBe(true);
      expect(() => prepareExternalMessageActionTargetForResolution(context)).toThrow(
        "requires the exact current conversation and account",
      );
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "requires the exact current conversation and account",
      );
      expect(root.handleAction).not.toHaveBeenCalled();
    });
    expect(await dispatchChannelMessageAction(context)).toBe(receipt);
  });

  it.each([
    "replace",
    "replace-error",
    "reactivate",
    "remove",
    "disable",
    "revoke",
    "trust-downgrade",
    "reregister",
  ] as const)("rejects an in-flight official read after owner %s", async (change) => {
    const fixture = registerChannel({ trustedOfficialInstall: true, providerOwnedReadGates: true });
    const pending = Promise.withResolvers<typeof receipt>();
    fixture.handleAction.mockReturnValueOnce(pending.promise);
    const read = dispatchChannelMessageAction(context);
    expect(fixture.handleAction).toHaveBeenCalledOnce();
    switch (change) {
      case "replace":
      case "replace-error":
        setActivePluginRegistry(createTestRegistry([]));
        break;
      case "reactivate":
        setActivePluginRegistry(fixture.owner.registry);
        break;
      case "remove":
        fixture.owner.registry.plugins.splice(0);
        break;
      case "disable":
        fixture.record.enabled = false;
        break;
      case "revoke":
        revokePluginRecordLifecycleEpoch(fixture.owner.registry, fixture.record);
        break;
      case "trust-downgrade":
        fixture.record.trustedOfficialInstall = false;
        break;
      case "reregister":
        fixture.owner
          .createApi(fixture.record, { config: {}, registrationMode: "full" })
          .registerChannel({ plugin: fixture.plugin });
        break;
    }
    if (change === "replace-error") {
      pending.reject(new Error("provider error with stale data"));
    } else {
      pending.resolve(receipt);
    }
    await expect(read).rejects.toThrow("read authority is no longer active");
  });
});
