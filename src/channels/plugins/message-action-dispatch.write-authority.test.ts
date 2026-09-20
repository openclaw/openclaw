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
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

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
  it.each(["global", "bundled"] as const)(
    "projects only the declared operator action through an active %s registration",
    async (origin) => {
      const fixture = registerWriter({ origin, trusted: origin === "global" });
      expect(await dispatchChannelMessageAction(fixture.context)).toBe(receipt);
      const received = fixture.handleAction.mock.calls[0]?.[0];
      expect(received?.senderIsOwner).toBe(true);
      expect(received?.toolContext).toBeUndefined();
      expect(received?.requesterSenderId).toBeUndefined();
      expect(received).not.toHaveProperty("messageActionAuthorization");
      expect(fixture.context.senderIsOwner).toBe(false);
    },
  );

  it.each([{ trusted: false }, { writes: [] }, { writes: ["read"] as const }])(
    "does not infer writer support or registration authority from action arguments (%j)",
    async (options) => {
      const fixture = registerWriter(options);
      fixture.context.params.writeAuthorityActions = ["channel-edit"];
      fixture.context.params.trustedOfficialInstall = true;
      fixture.context.params.senderIsOwner = true;
      await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "write authorization support",
      );
      expect(fixture.handleAction).not.toHaveBeenCalled();
    },
  );

  it("does not borrow writer authority from a root registration into an empty scope", async () => {
    const fixture = registerWriter();
    await withPluginRuntimeRegistryScope(createTestRegistry([]), async () => {
      await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "write authorization support",
      );
    });
    expect(fixture.handleAction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "closes a retained request callback after completion (error=%s)",
    async (error) => {
      const fixture = registerWriter();
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
      expect(fixture.source.signal.aborted).toBe(false);
      expect(retained).toBeTypeOf("function");
      expect(retained).toThrow("invocation is no longer active");
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
