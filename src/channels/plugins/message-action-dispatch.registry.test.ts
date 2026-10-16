import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { projectPluginContributions } from "../../plugins/registry-contributions.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "../../plugins/registry.js";
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
import * as bundled from "./bundled.js";
import {
  dispatchChannelMessageAction,
  prepareExternalMessageActionTargetForResolution,
  shouldDeferExternalMessageActionTargetResolution,
} from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.public.js";

const receipt = { content: [{ type: "text" as const, text: "delivered" }], details: { ok: true } };
type Context = Parameters<typeof dispatchChannelMessageAction>[0];

function scopedRegistry(plugin: ChannelPlugin, origin: "config" | "bundled") {
  return createTestRegistry([{ pluginId: origin, source: origin, origin, plugin }]);
}

function pauseRead(fixture: {
  handleAction: ReturnType<
    typeof vi.fn<(ctx: ChannelMessageActionContext) => Promise<typeof receipt>>
  >;
}) {
  const resume = createDeferred();
  const entered = createDeferred();
  const nextRequest = vi.fn();
  fixture.handleAction.mockImplementation(async () => {
    entered.resolve();
    const assertCurrent = captureChannelReadAuthority();
    expect(assertCurrent).toBeTypeOf("function");
    await resume.promise;
    assertCurrent?.();
    nextRequest();
    return receipt;
  });
  return { resume, entered, nextRequest };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("message action registration ownership", () => {
  it("does not borrow a missing scoped action capability", async () => {
    const handleRootAction = vi.fn(async () => receipt);
    const base = createChannelTestPluginBase({ id: "scoped-delivery" });
    const root = { ...base, actions: { handleAction: handleRootAction } };
    setActivePluginRegistry(scopedRegistry(root, "bundled"));
    const registry = scopedRegistry(base, "config");

    const result = await withPluginRuntimeRegistryScope(registry, () =>
      dispatchChannelMessageAction({
        cfg: {},
        channel: base.id,
        action: "send",
        params: { to: "recipient", message: "hello" },
      }),
    );

    expect(result).toBeNull();
    expect(handleRootAction).not.toHaveBeenCalled();
  });
  it("keeps scoped channel read authority external beside a bundled same-id registration", async () => {
    const handleRootAction = vi.fn(async () => receipt);
    const handleScopedAction = vi.fn(async () => receipt);
    const base = createChannelTestPluginBase({ id: "scoped-delivery" });
    setActivePluginRegistry(
      scopedRegistry(
        {
          ...base,
          actions: { providerOwnedReadGates: true, handleAction: handleRootAction },
        },
        "bundled",
      ),
    );
    const registry = scopedRegistry(
      {
        ...base,
        actions: { providerOwnedReadGates: true, handleAction: handleScopedAction },
      },
      "config",
    );
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
      origin?: "global" | "bundled";
      fenced?: boolean;
      readActions?: NonNullable<ChannelPlugin["actions"]>["readAuthorityActions"];
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
      origin: options.origin ?? "global",
      trustedOfficialInstall: options.trusted ?? true,
    });
    const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => receipt);
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "configured-reader" }),
      actions: {
        describeMessageTool: () => ({ actions: ["read", "search"] }),
        providerOwnedReadGates: options.gates ?? true,
        readAuthorityActions:
          options.fenced === false
            ? undefined
            : (options.readActions ?? [
                "read",
                "search",
                "reactions",
                "list-pins",
                "thread-list",
                "channel-info",
              ]),
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
    const dispatch = (overrides: Partial<Context> = {}) =>
      dispatchChannelMessageAction({ ...context, ...overrides });
    const prepare = (overrides: Partial<Context> = {}) =>
      prepareExternalMessageActionTargetForResolution({ ...context, ...overrides });
    return { owner, record, plugin, handleAction, register, context, dispatch, prepare };
  }

  it.each(["read", "download-file"] as const)(
    "dispatches configured cross-conversation %s",
    async (action) => {
      const fixture = registerReader({ readActions: [action] });
      const ctx = { ...fixture.context, action };
      // A client must still defer to the Gateway's attested live registration.
      expect(shouldDeferExternalMessageActionTargetResolution(ctx)).toBe(true);
      expect((await prepareExternalMessageActionTargetForResolution(ctx)).params).toBe(ctx.params);
      expect(await dispatchChannelMessageAction(ctx)).toBe(receipt);
      expect(fixture.handleAction).toHaveBeenCalledOnce();
    },
  );

  it("does not enroll an existing reader into download authority", async () => {
    const fixture = registerReader();
    await expect(fixture.dispatch({ action: "download-file" })).rejects.toThrow(
      "exact current conversation",
    );
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it("admits a dashboard read without promoting its origin or replacing native context", async () => {
    const fixture = registerReader();
    const assertDashboardReadCurrent = vi.fn();
    const context = {
      ...fixture.context,
      requesterAccountId: undefined,
      toolContext: undefined,
      assertDirectAdapterHandoff: vi.fn(),
    };
    await expect(prepareExternalMessageActionTargetForResolution(context)).rejects.toThrow(
      "requires current provider and account context",
    );
    const authorized = {
      ...context,
      messageActionAuthorization: { assertDashboardReadCurrent },
    };
    expect((await prepareExternalMessageActionTargetForResolution(authorized)).params).toBe(
      context.params,
    );
    await expect(dispatchChannelMessageAction(authorized)).resolves.toBe(receipt);
    expect(assertDashboardReadCurrent).toHaveBeenCalled();
    expect(fixture.handleAction.mock.calls[0]?.[0].conversationReadOrigin).toBe("delegated");
    expect(fixture.handleAction.mock.calls[0]?.[0]).not.toHaveProperty(
      "messageActionAuthorization",
    );
    await expect(
      dispatchChannelMessageAction({
        ...authorized,
        requesterAccountId: "another-account",
        toolContext: fixture.context.toolContext,
      }),
    ).rejects.toThrow("requires current provider and account context");
    assertDashboardReadCurrent.mockImplementation(() => {
      throw new Error("dashboard admission closed");
    });
    await expect(dispatchChannelMessageAction(authorized)).rejects.toThrow(
      "dashboard admission closed",
    );
    expect(fixture.handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    { trusted: false },
    { fenced: false },
    { gates: ["search"] as const },
    { readActions: ["search"] as const },
  ])("does not accept an untrusted, legacy, or undeclared read (%j)", async (options) => {
    const fixture = registerReader(options);
    Object.assign(fixture.plugin, { trustedOfficialInstall: true });
    fixture.context.params.trustedOfficialInstall = true;
    await expect(fixture.prepare()).rejects.toThrow("exact current conversation");
    await expect(fixture.dispatch()).rejects.toThrow("exact current conversation");
    expect(fixture.handleAction).not.toHaveBeenCalled();
    // Existing exact-current and direct-operator behavior is unchanged.
    await expect(
      fixture.dispatch({
        requesterAccountId: undefined,
        toolContext: undefined,
        messageActionAuthorization: { assertDashboardReadCurrent: vi.fn() },
      }),
    ).rejects.toThrow("exact current conversation");
    expect(await fixture.dispatch({ params: { to: "current" } })).toBe(receipt);
    expect(await fixture.dispatch({ conversationReadOrigin: "direct-operator" })).toBe(receipt);
  });

  it.each(["react"] as const)("does not broaden %s authority", async (action) => {
    const fixture = registerReader({ readActions: [action] });
    await expect(fixture.dispatch({ action })).rejects.toThrow("exact current conversation");
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it.each([
    { requesterAccountId: "other-account" },
    { requesterAccountId: undefined },
    { toolContext: undefined },
    { toolContext: { currentChannelProvider: "other-provider", currentChannelId: "current" } },
  ])("retains originating provider/account context (%j)", async (mismatch) => {
    const fixture = registerReader();
    await expect(fixture.dispatch(mismatch)).rejects.toThrow(
      "current provider and account context",
    );
    expect(fixture.handleAction).not.toHaveBeenCalled();
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
        await expect(root.dispatch()).rejects.toThrow("exact current conversation");
      });
      expect(root.handleAction).not.toHaveBeenCalled();
      expect(scope.handleAction).not.toHaveBeenCalled();
      expect(await root.dispatch()).toBe(receipt);
    },
  );

  it.each([
    { change: "reactivate", origin: "global" },
    { change: "adopt", origin: "global" },
    { change: "reactivate", origin: "bundled" },
    { change: "adopt", origin: "bundled" },
  ] as const)(
    "retains an unchanged $origin registration across $change",
    async ({ change, origin }) => {
      const fixture = registerReader({ origin, trusted: origin !== "bundled" });
      const { resume, entered, nextRequest } = pauseRead(fixture);
      const read = fixture.dispatch();
      await entered.promise;
      if (change === "adopt") {
        const next = createEmptyPluginRegistry();
        next.plugins.push(fixture.record);
        projectPluginContributions(fixture.owner.registry, fixture.record, next);
        setActivePluginRegistry(next);
      } else {
        setActivePluginRegistry(fixture.owner.registry);
      }
      resume.resolve();
      await expect(read).resolves.toBe(receipt);
      expect(nextRequest).toHaveBeenCalledOnce();
      // The retained registration can also admit a new invocation after publication.
      await expect(fixture.dispatch()).resolves.toBe(receipt);
      expect(nextRequest).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves bundled provider-owned admission with a live read fence", async () => {
    const fixture = registerReader({ origin: "bundled", trusted: false });
    let retained: (() => void) | undefined;
    fixture.handleAction.mockImplementation(async () => {
      retained = captureChannelReadAuthority();
      return receipt;
    });
    expect(
      await fixture.dispatch({
        requesterAccountId: undefined,
        toolContext: undefined,
      }),
    ).toBe(receipt);
    expect(retained).toBeTypeOf("function");
    expect(retained).toThrow("read authority is no longer active");
  });

  it.each(["artifact", "scope"] as const)(
    "does not execute an opted-in bundled read through an unowned %s fallback",
    async (fallback) => {
      const fixture = registerReader({ origin: "bundled", trusted: false });
      if (fallback === "artifact") {
        setActivePluginRegistry(createTestRegistry([]));
        vi.spyOn(bundled, "getBundledChannelPlugin").mockReturnValue(fixture.plugin);
      }
      const assertDenied = async () => {
        expect(shouldDeferExternalMessageActionTargetResolution(fixture.context)).toBe(true);
        await expect(fixture.prepare()).rejects.toThrow("read authority is no longer active");
        await expect(fixture.dispatch()).rejects.toThrow("read authority is no longer active");
        expect(fixture.handleAction).not.toHaveBeenCalled();
        expect(await fixture.dispatch({ conversationReadOrigin: "direct-operator" })).toBe(receipt);
      };
      if (fallback === "scope") {
        await withPluginRuntimeRegistryScope(createTestRegistry([]), assertDenied);
      } else {
        await assertDenied();
      }
    },
  );

  it.each(["replace", "disable", "remove", "revoke", "reregister", "trust-downgrade"] as const)(
    "fences subsequent I/O and results after %s",
    async (change) => {
      const fixture = registerReader();
      const { resume, entered, nextRequest } = pauseRead(fixture);
      const read = fixture.dispatch();
      const rejected = expect(read).rejects.toThrow("read authority is no longer active");
      await entered.promise;
      switch (change) {
        case "replace":
          setActivePluginRegistry(createTestRegistry([]));
          break;
        case "disable":
          fixture.record.enabled = false;
          break;
        case "remove":
          fixture.owner.registry.plugins.splice(0);
          break;
        case "revoke":
          revokePluginRecord(fixture.owner.registry, fixture.record);
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
    },
  );

  it.each([false, true])(
    "suppresses already-issued results or errors after revocation (error=%s)",
    async (error) => {
      const fixture = registerReader();
      const pending = createDeferred<typeof receipt>();
      const entered = createDeferred();
      fixture.handleAction.mockImplementation(() => {
        entered.resolve();
        return pending.promise;
      });
      const read = fixture.dispatch();
      const rejected = expect(read).rejects.toThrow("read authority is no longer active");
      await entered.promise;
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
    const prepared = await first.prepare();
    let replacement: ReturnType<typeof registerReader> | undefined;
    await expect(
      withChannelReadAuthority(prepared.assertReadAuthorityCurrent, async () => {
        await Promise.resolve();
        replacement = registerReader();
        return await replacement.dispatch();
      }),
    ).rejects.toThrow("read authority is no longer active");
    expect(first.handleAction).not.toHaveBeenCalled();
    expect(replacement?.handleAction).not.toHaveBeenCalled();
  });
});
