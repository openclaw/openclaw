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
const inactiveRead = "read authority is no longer active";
const exactConversation = "exact current conversation";
const noCurrentContext = { requesterAccountId: undefined, toolContext: undefined };
type Context = Parameters<typeof dispatchChannelMessageAction>[0];

function scopedReader(read: boolean) {
  const base = createChannelTestPluginBase({ id: "scoped-delivery" });
  const handleRootAction = vi.fn(async () => receipt);
  const handleScopedAction = vi.fn(async () => receipt);
  const registryFor = (origin: "config" | "bundled", handleAction?: typeof handleRootAction) => {
    const actions = handleAction && { handleAction, providerOwnedReadGates: read || undefined };
    return createTestRegistry([
      { pluginId: origin, source: origin, origin, plugin: { ...base, actions } },
    ]);
  };
  setActivePluginRegistry(registryFor("bundled", handleRootAction));
  const registry = registryFor("config", read ? handleScopedAction : undefined);
  const dispatch = (overrides: Partial<Context> = {}) =>
    dispatchChannelMessageAction({
      cfg: {},
      channel: base.id,
      action: read ? "read" : "send",
      params: read ? { to: "recipient" } : { to: "recipient", message: "hello" },
      ...overrides,
    });
  return { registry, dispatch, handleRootAction, handleScopedAction, channel: base.id };
}

function pauseRead(
  fixture: Pick<ReturnType<typeof registerReader>, "handleAction">,
  fenced = true,
) {
  const resume = createDeferred();
  const entered = createDeferred();
  const nextRequest = vi.fn();
  fixture.handleAction.mockImplementation(async () => {
    entered.resolve();
    const assertCurrent = fenced ? captureChannelReadAuthority() : undefined;
    if (fenced) {
      expect(assertCurrent).toBeTypeOf("function");
    }
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
    const fixture = scopedReader(false);
    expect(
      await withPluginRuntimeRegistryScope(fixture.registry, () => fixture.dispatch()),
    ).toBeNull();
    expect(fixture.handleRootAction).not.toHaveBeenCalled();
  });
  it("keeps scoped channel read authority external beside a bundled same-id registration", async () => {
    const fixture = scopedReader(true);
    await withPluginRuntimeRegistryScope(fixture.registry, async () => {
      await expect(fixture.dispatch({ conversationReadOrigin: "delegated" })).rejects.toThrow(
        "requires the exact current conversation and account",
      );
      expect(fixture.handleScopedAction).not.toHaveBeenCalled();
      expect(fixture.handleRootAction).not.toHaveBeenCalled();
      expect(await fixture.dispatch({ conversationReadOrigin: "direct-operator" })).toBe(receipt);
      expect(
        await fixture.dispatch({
          conversationReadOrigin: "delegated",
          accountId: "ops",
          requesterAccountId: "ops",
          toolContext: { currentChannelProvider: fixture.channel, currentChannelId: "recipient" },
        }),
      ).toBe(receipt);
      expect(fixture.handleScopedAction).toHaveBeenCalledTimes(2);
      expect(fixture.handleRootAction).not.toHaveBeenCalled();
    });
  });
});

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
        options.fenced === false ? undefined : (options.readActions ?? ["read", "search"]),
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

describe("official plugin read-only authority", () => {
  it.each(["read", "download-file"] as const)("admits cross-conversation %s", async (action) => {
    const fixture = registerReader({ readActions: [action] });
    const ctx = { ...fixture.context, action };
    expect(shouldDeferExternalMessageActionTargetResolution(ctx)).toBe(true);
    expect((await prepareExternalMessageActionTargetForResolution(ctx)).params).toBe(ctx.params);
    expect(await dispatchChannelMessageAction(ctx)).toBe(receipt);
    expect(fixture.handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    ["download-file", undefined],
    ["react", ["react"]],
  ] as const)("does not broaden %s authority", async (action, readActions) => {
    const fixture = registerReader({ readActions });
    await expect(fixture.dispatch({ action })).rejects.toThrow(exactConversation);
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it("admits a dashboard read without promoting its origin or replacing native context", async () => {
    const fixture = registerReader();
    const assertDashboardReadCurrent = vi.fn();
    const context = {
      ...fixture.context,
      ...noCurrentContext,
      assertDirectAdapterHandoff: vi.fn(),
    };
    await expect(fixture.prepare(context)).rejects.toThrow(
      "requires current provider and account context",
    );
    const authorized = {
      ...context,
      messageActionAuthorization: { assertDashboardReadCurrent },
    };
    expect((await fixture.prepare(authorized)).params).toBe(context.params);
    await expect(fixture.dispatch(authorized)).resolves.toBe(receipt);
    expect(assertDashboardReadCurrent).toHaveBeenCalled();
    const delivered = fixture.handleAction.mock.calls[0]?.[0];
    expect(delivered).toMatchObject({ conversationReadOrigin: "delegated" });
    expect(delivered).not.toHaveProperty("messageActionAuthorization");
    await expect(
      fixture.dispatch({
        ...authorized,
        requesterAccountId: "another-account",
        toolContext: fixture.context.toolContext,
      }),
    ).rejects.toThrow("requires current provider and account context");
    assertDashboardReadCurrent.mockImplementation(() => {
      throw new Error("dashboard admission closed");
    });
    await expect(fixture.dispatch(authorized)).rejects.toThrow("dashboard admission closed");
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
    await expect(fixture.prepare()).rejects.toThrow(exactConversation);
    await expect(fixture.dispatch()).rejects.toThrow(exactConversation);
    expect(fixture.handleAction).not.toHaveBeenCalled();
    await expect(
      fixture.dispatch({
        ...noCurrentContext,
        messageActionAuthorization: { assertDashboardReadCurrent: vi.fn() },
      }),
    ).rejects.toThrow(exactConversation);
    expect(await fixture.dispatch({ params: { to: "current" } })).toBe(receipt);
    expect(await fixture.dispatch({ conversationReadOrigin: "direct-operator" })).toBe(receipt);
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

  it.each([false, true])("does not borrow root authority (has channel=%s)", async (hasChannel) => {
    const scope = registerReader({ trusted: false, activate: false });
    if (!hasChannel) {
      scope.owner.registry.channels.splice(0);
    }
    const root = registerReader();
    await withPluginRuntimeRegistryScope(scope.owner.registry, async () => {
      await expect(root.dispatch()).rejects.toThrow(exactConversation);
    });
    expect(root.handleAction).not.toHaveBeenCalled();
    expect(scope.handleAction).not.toHaveBeenCalled();
    expect(await root.dispatch()).toBe(receipt);
  });

  it.each([
    { change: "reactivate", origin: "global" },
    { change: "adopt", origin: "global" },
    { change: "reactivate", origin: "bundled" },
    { change: "adopt", origin: "bundled" },
  ] as const)("retains $origin reads across $change", async ({ change, origin }) => {
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
    await expect(fixture.dispatch()).resolves.toBe(receipt);
    expect(nextRequest).toHaveBeenCalledTimes(2);
  });

  it("preserves bundled provider-owned admission with a live read fence", async () => {
    const fixture = registerReader({ origin: "bundled", trusted: false });
    let retained: (() => void) | undefined;
    fixture.handleAction.mockImplementation(async () => {
      retained = captureChannelReadAuthority();
      return receipt;
    });
    expect(await fixture.dispatch(noCurrentContext)).toBe(receipt);
    expect(retained).toBeTypeOf("function");
    expect(retained).toThrow(inactiveRead);
  });

  it.each(["artifact", "scope"] as const)("fences bundled %s fallbacks", async (fallback) => {
    const fixture = registerReader({ origin: "bundled", trusted: false });
    if (fallback === "artifact") {
      setActivePluginRegistry(createTestRegistry([]));
      vi.spyOn(bundled, "getBundledChannelPlugin").mockReturnValue(fixture.plugin);
    }
    const assertDenied = async () => {
      expect(shouldDeferExternalMessageActionTargetResolution(fixture.context)).toBe(true);
      await expect(fixture.prepare()).rejects.toThrow(inactiveRead);
      await expect(fixture.dispatch()).rejects.toThrow(inactiveRead);
      expect(fixture.handleAction).not.toHaveBeenCalled();
      expect(await fixture.dispatch({ conversationReadOrigin: "direct-operator" })).toBe(receipt);
    };
    if (fallback === "scope") {
      await withPluginRuntimeRegistryScope(createTestRegistry([]), assertDenied);
    } else {
      await assertDenied();
    }
  });

  it.each<[string, (fixture: ReturnType<typeof registerReader>) => void]>([
    ["replace", () => setActivePluginRegistry(createTestRegistry([]))],
    ["disable", ({ record }) => Object.assign(record, { enabled: false })],
    ["remove", ({ owner }) => owner.registry.plugins.splice(0)],
    ["revoke", ({ owner, record }) => revokePluginRecord(owner.registry, record)],
    ["reregister", ({ register }) => register()],
    ["trust-downgrade", ({ record }) => Object.assign(record, { trustedOfficialInstall: false })],
  ])("fences subsequent I/O and results after %s", async (_change, invalidate) => {
    const fixture = registerReader();
    const { resume, entered, nextRequest } = pauseRead(fixture);
    const read = fixture.dispatch();
    const rejected = expect(read).rejects.toThrow(inactiveRead);
    await entered.promise;
    invalidate(fixture);
    resume.resolve();
    await rejected;
    expect(nextRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])("suppresses revoked responses (error=%s)", async (error) => {
    const fixture = registerReader();
    const { resume, entered } = pauseRead(fixture, false);
    const read = fixture.dispatch();
    const rejected = expect(read).rejects.toThrow(inactiveRead);
    await entered.promise;
    fixture.record.enabled = false;
    if (error) {
      resume.reject(new Error("stale provider response"));
    } else {
      resume.resolve();
    }
    await rejected;
  });

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
    ).rejects.toThrow(inactiveRead);
    expect(first.handleAction).not.toHaveBeenCalled();
    expect(replacement?.handleAction).not.toHaveBeenCalled();
  });
});
