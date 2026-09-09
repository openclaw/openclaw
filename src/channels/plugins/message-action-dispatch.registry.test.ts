import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { revokePluginRecordLifecycleEpoch } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  captureChannelReadAuthority,
  withChannelReadAuthority,
} from "../../shared/channel-read-authority.js";
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

describe("official plugin read-only authority", () => {
  function registerReader(
    options: {
      trusted?: boolean;
      fenced?: boolean;
      gates?: NonNullable<ChannelPlugin["actions"]>["providerOwnedReadGates"];
      activate?: boolean;
    } = {},
  ) {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "official-reader",
      origin: "global",
      trustedOfficialInstall: options.trusted ?? true,
    });
    const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => receipt);
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "configured-reader" }),
      actions: {
        describeMessageTool: () => ({ actions: ["read", "search"] }),
        providerOwnedReadGates: options.gates ?? true,
        supportsReadAuthority: options.fenced === false ? undefined : true,
        handleAction,
      },
    };
    owner.registry.plugins.push(record);
    const register = () =>
      owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
    register();
    if (options.activate !== false) {
      setActivePluginRegistry(owner.registry);
    }
    const context: ChannelMessageActionContext = {
      cfg: {},
      channel: plugin.id,
      action: "read",
      params: { channelId: "other" },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: plugin.id, currentChannelId: "current" },
    };
    return { owner, record, plugin, handleAction, register, context };
  }

  it.each(["read", "search", "reactions", "list-pins", "thread-list", "channel-info"] as const)(
    "dispatches configured cross-conversation %s",
    async (action) => {
      const fixture = registerReader();
      const ctx = { ...fixture.context, action };
      // A client must still defer to the Gateway's attested live registration.
      expect(shouldDeferExternalMessageActionTargetResolution(ctx)).toBe(true);
      expect(prepareExternalMessageActionTargetForResolution(ctx).params).toBe(ctx.params);
      expect(await dispatchChannelMessageAction(ctx)).toBe(receipt);
      expect(fixture.handleAction).toHaveBeenCalledOnce();
    },
  );

  it.each([{ trusted: false }, { fenced: false }, { gates: ["search"] as const }])(
    "does not accept an untrusted, legacy, or undeclared read (%j)",
    async (options) => {
      const fixture = registerReader(options);
      Object.assign(fixture.plugin, { trustedOfficialInstall: true });
      fixture.context.params.trustedOfficialInstall = true;
      expect(() => prepareExternalMessageActionTargetForResolution(fixture.context)).toThrow(
        "exact current conversation",
      );
      await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "exact current conversation",
      );
      expect(fixture.handleAction).not.toHaveBeenCalled();
      // Existing exact-current and direct-operator behavior is unchanged.
      expect(
        await dispatchChannelMessageAction({
          ...fixture.context,
          params: { to: "current" },
        }),
      ).toBe(receipt);
      expect(
        await dispatchChannelMessageAction({
          ...fixture.context,
          conversationReadOrigin: "direct-operator",
        }),
      ).toBe(receipt);
    },
  );

  it.each([
    "react",
    "poll-vote",
    "edit",
    "delete",
    "pin",
    "unpin",
    "unsend",
    "download-file",
  ] as const)("does not broaden %s authority", async (action) => {
    const fixture = registerReader();
    await expect(dispatchChannelMessageAction({ ...fixture.context, action })).rejects.toThrow(
      "exact current conversation",
    );
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it.each([
    { requesterAccountId: "other-account" },
    { requesterAccountId: undefined },
    { toolContext: undefined },
    { toolContext: { currentChannelProvider: "other-provider", currentChannelId: "current" } },
  ])("retains originating provider/account context (%j)", async (mismatch) => {
    const fixture = registerReader();
    await expect(dispatchChannelMessageAction({ ...fixture.context, ...mismatch })).rejects.toThrow(
      "current provider and account context",
    );
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it("retains provider destination policy", async () => {
    const fixture = registerReader();
    fixture.handleAction.mockRejectedValue(new Error("provider denied destination"));
    await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
      "provider denied destination",
    );
    expect(fixture.handleAction).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "does not borrow root authority into a scope (has channel=%s)",
    async (hasChannel) => {
      const scope = registerReader({ trusted: false, activate: false });
      if (!hasChannel) {
        scope.owner.registry.channels.splice(0);
      }
      const root = registerReader();
      await withPluginRuntimeRegistryScope(scope.owner.registry, async () => {
        await expect(dispatchChannelMessageAction(root.context)).rejects.toThrow(
          "exact current conversation",
        );
      });
      expect(root.handleAction).not.toHaveBeenCalled();
      expect(scope.handleAction).not.toHaveBeenCalled();
      expect(await dispatchChannelMessageAction(root.context)).toBe(receipt);
    },
  );

  it.each([
    "replace",
    "reactivate",
    "disable",
    "remove",
    "revoke",
    "reregister",
    "trust-downgrade",
  ] as const)("fences subsequent I/O and results after %s", async (change) => {
    const fixture = registerReader();
    const resume = createDeferred();
    const nextRequest = vi.fn();
    fixture.handleAction.mockImplementation(async () => {
      const assertCurrent = captureChannelReadAuthority();
      expect(assertCurrent).toBeTypeOf("function");
      await resume.promise;
      assertCurrent?.();
      nextRequest();
      return receipt;
    });
    const read = dispatchChannelMessageAction(fixture.context);
    const rejected = expect(read).rejects.toThrow("read authority is no longer active");
    switch (change) {
      case "replace":
        setActivePluginRegistry(createTestRegistry([]));
        break;
      case "reactivate":
        setActivePluginRegistry(fixture.owner.registry);
        break;
      case "disable":
        fixture.record.enabled = false;
        break;
      case "remove":
        fixture.owner.registry.plugins.splice(0);
        break;
      case "revoke":
        revokePluginRecordLifecycleEpoch(fixture.owner.registry, fixture.record);
        break;
      case "reregister":
        fixture.register();
        break;
      case "trust-downgrade":
        fixture.record.trustedOfficialInstall = false;
        break;
    }
    resume.resolve();
    await rejected;
    expect(nextRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "suppresses already-issued results or errors after revocation (error=%s)",
    async (error) => {
      const fixture = registerReader();
      const pending = createDeferred<typeof receipt>();
      fixture.handleAction.mockReturnValue(pending.promise);
      const read = dispatchChannelMessageAction(fixture.context);
      const rejected = expect(read).rejects.toThrow("read authority is no longer active");
      fixture.record.enabled = false;
      if (error) {
        pending.reject(new Error("stale provider response"));
      } else {
        pending.resolve(receipt);
      }
      await rejected;
    },
  );

  it("does not refresh a captured route's authority after awaited target resolution", async () => {
    const first = registerReader();
    const prepared = prepareExternalMessageActionTargetForResolution(first.context);
    let replacement: ReturnType<typeof registerReader> | undefined;
    await expect(
      withChannelReadAuthority(prepared.assertReadAuthorityCurrent, async () => {
        await Promise.resolve();
        replacement = registerReader();
        return await dispatchChannelMessageAction(replacement.context);
      }),
    ).rejects.toThrow("read authority is no longer active");
    expect(first.handleAction).not.toHaveBeenCalled();
    expect(replacement?.handleAction).not.toHaveBeenCalled();
  });

  it("closes retained transport authority when the action finishes", async () => {
    const fixture = registerReader();
    let retained: (() => void) | undefined;
    fixture.handleAction.mockImplementation(async () => {
      retained = captureChannelReadAuthority();
      return receipt;
    });
    expect(await dispatchChannelMessageAction(fixture.context)).toBe(receipt);
    expect(retained).toBeTypeOf("function");
    expect(retained).toThrow("read authority is no longer active");
    expect(captureChannelReadAuthority()).toBeUndefined();
  });
});
