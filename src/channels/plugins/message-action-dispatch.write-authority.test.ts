import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.public.js";

const receipt = { content: [{ type: "text" as const, text: "edited" }], details: { ok: true } };

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

function registerWriter(
  options: {
    trusted?: boolean;
    origin?: "global" | "bundled";
    writes?: NonNullable<ChannelPlugin["actions"]>["writeAuthorityActions"];
  } = {},
) {
  const cfg = {};
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "official-writer",
    origin: options.origin ?? "global",
    trustedOfficialInstall: options.trusted ?? true,
  });
  const handleAction = vi.fn(async (_context: ChannelMessageActionContext) => receipt);
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "declared-writer" }),
    actions: {
      describeMessageTool: () => ({ actions: ["channel-edit"] }),
      writeAuthorityActions: options.writes ?? ["channel-edit"],
      handleAction,
    },
  };
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({ plugin });
  setActivePluginRegistry(owner.registry);
  const source = new AbortController();
  const context: Parameters<typeof dispatchChannelMessageAction>[0] = {
    cfg,
    channel: plugin.id,
    action: "channel-edit",
    params: { channelId: "fixture", topic: "new topic" },
    accountId: "default",
    senderIsOwner: false,
    messageActionAuthorization: {
      scheduled: {
        policy: { version: 1, mode: "trusted" },
        assertCurrent: () => source.signal.throwIfAborted(),
      },
    },
  };
  return { owner, record, plugin, handleAction, source, context };
}

describe("scheduled message write declaration", () => {
  it.each([
    { origin: "global", error: false },
    { origin: "bundled", error: false },
    { origin: "global", error: true },
  ] as const)(
    "projects declared $origin writes and closes completed callbacks (error=$error)",
    async ({ origin, error }) => {
      const fixture = registerWriter({ origin, trusted: origin === "global" });
      let retained: (() => void) | undefined;
      fixture.handleAction.mockImplementation(async (context) => {
        retained = context.assertDirectAdapterHandoff;
        retained?.();
        if (error) {
          throw new Error("provider rejected edit");
        }
        return receipt;
      });
      const request = dispatchChannelMessageAction(fixture.context);
      if (error) {
        await expect(request).rejects.toThrow("provider rejected edit");
      } else {
        await expect(request).resolves.toBe(receipt);
      }
      const received = fixture.handleAction.mock.calls[0]?.[0];
      expect(received?.senderIsOwner).toBe(true);
      expect(received?.toolContext).toBeUndefined();
      expect(received?.requesterSenderId).toBeUndefined();
      expect(received).not.toHaveProperty("messageActionAuthorization");
      expect(fixture.context.senderIsOwner).toBe(false);
      expect(fixture.source.signal.aborted).toBe(false);
      expect(retained).toBeTypeOf("function");
      expect(retained).toThrow("invocation is no longer active");
    },
  );

  it.each([
    { name: "untrusted registration", options: { trusted: false }, emptyScope: false },
    { name: "undeclared action", options: { writes: ["read"] }, emptyScope: false },
    { name: "empty scope", options: {}, emptyScope: true },
  ] satisfies {
    name: string;
    options: Parameters<typeof registerWriter>[0];
    emptyScope: boolean;
  }[])("rejects $name regardless of forged action arguments", async ({ options, emptyScope }) => {
    const fixture = registerWriter(options);
    fixture.context.params.writeAuthorityActions = ["channel-edit"];
    fixture.context.params.trustedOfficialInstall = true;
    fixture.context.params.senderIsOwner = true;
    const run = () =>
      expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "write authorization support",
      );
    if (emptyScope) {
      await withPluginRuntimeRegistryScope(createTestRegistry([]), run);
    } else {
      await run();
    }
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it.each(["sent", "rejected", "revoked"] as const)(
    "awaits the dispatch hook and fences its %s outcome before the adapter",
    async (outcome) => {
      const fixture = registerWriter();
      let hookFinished = false;
      let fencedAfterHook = false;
      fixture.context.onPlatformSendDispatch = vi.fn(async () => {
        await Promise.resolve();
        hookFinished = true;
        if (outcome !== "sent") {
          throw new Error("source conversation changed before delivery");
        }
      });
      fixture.context.assertDirectAdapterHandoff = () => {
        if (hookFinished) {
          fencedAfterHook = true;
          if (outcome === "revoked") {
            throw new Error("caller authority ended");
          }
        }
      };
      fixture.handleAction.mockImplementation(async () => {
        expect(hookFinished).toBe(true);
        expect(fencedAfterHook).toBe(true);
        return receipt;
      });
      const request = dispatchChannelMessageAction(fixture.context);
      if (outcome === "sent") {
        await expect(request).resolves.toBe(receipt);
      } else {
        await expect(request).rejects.toThrow(
          outcome === "revoked"
            ? "caller authority ended"
            : "source conversation changed before delivery",
        );
      }
      expect(fencedAfterHook).toBe(true);
      expect(fixture.context.onPlatformSendDispatch).toHaveBeenCalledTimes(1);
      expect(fixture.handleAction).toHaveBeenCalledTimes(outcome === "sent" ? 1 : 0);
    },
  );

  it("stops a pending request after its plugin authority ends", async () => {
    const fixture = registerWriter();
    const entered = createDeferred();
    const release = createDeferred();
    const write = vi.fn();
    fixture.handleAction.mockImplementation(async (context) => {
      entered.resolve();
      await release.promise;
      context.assertDirectAdapterHandoff?.();
      write();
      return receipt;
    });
    const request = dispatchChannelMessageAction(fixture.context);
    const rejected = expect(request).rejects.toThrow(/authority|retired/);
    try {
      await entered.promise;
      revokePluginRecord(fixture.owner.registry, fixture.record);
      release.resolve();
      await rejected;
      expect(write).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([request]);
    }
  });
});
