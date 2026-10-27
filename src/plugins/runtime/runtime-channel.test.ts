import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const dispatchRoutedChannelTurn = vi.hoisted(() => vi.fn(async () => ({ status: "handled" })));

vi.mock("../../channels/turn/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/turn/lifecycle.js")>()),
  dispatchRoutedChannelTurn,
}));

function expectWatcherEvents(mock: ReturnType<typeof vi.fn>, ...types: string[]) {
  expect(mock.mock.calls.map(([event]) => event.type)).toEqual(types);
}

it("warns about synchronous runtime timestamps while preserving the shipped result", async () => {
  await withOpenClawTestState({ label: "runtime-channel-legacy-timestamp" }, async (state) => {
    const scope = {
      storePath: state.statePath("timestamp", "openclaw-agent.sqlite"),
      sessionKey: "agent:main:legacy-timestamp",
    };
    replaceSessionEntrySync(scope, { sessionId: "legacy-timestamp", updatedAt: 60_000 });
    using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const channel = createRuntimeChannel();
    withPluginRuntimePluginScope({ pluginId: "legacy-runtime-timestamp-test" }, () => {
      expect(channel.session.readSessionUpdatedAt(scope)).toBe(60_000);
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("readSessionUpdatedAtAsync"),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
  });
});

describe("inbound dispatch", () => {
  it("removes event custody before invoking the host-bound reply dispatcher", async () => {
    const callback = vi.fn();
    const dispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }));
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const replyOptions = {
      disableTools: true,
      internalEventExecution: { assertCurrent: callback, onStarted: callback },
      onReplyOperationOwned: callback,
    };
    await channel.reply.dispatchReplyFromConfig({
      ctx: { Body: "test", CommandAuthorized: false },
      cfg: {},
      dispatcher: createReplyDispatcher({ deliver: async () => {} }),
      replyOptions,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ replyOptions: { disableTools: true } }),
    );
    expect(replyOptions.onReplyOperationOwned).toBe(callback);
  });

  it.each([true, false])("inbound preserves dispatch precedence (bound=%s)", async (bound) => {
    const boundReplyDispatch = bound ? vi.fn() : undefined;
    const callerDispatch = vi.fn();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: boundReplyDispatch });
    expect(channel.turn).toBe(channel.inbound);
    const replyOptions = {
      disableTools: true,
      internalEventExecution: { onStarted: vi.fn() },
      onReplyOperationOwned: vi.fn(),
    };
    const turn = {
      cfg: {},
      channel: "qa-channel",
      route: { agentId: "main", sessionKey: "agent:main:qa-channel:direct:test" },
      ctxPayload: { Body: "test", CommandAuthorized: false },
      delivery: { deliver: async () => undefined },
      dispatchReplyFromConfig: callerDispatch,
      replyOptions,
    } satisfies Parameters<typeof channel.inbound.dispatch>[0];

    await channel.inbound.dispatch(turn);

    expect(dispatchRoutedChannelTurn).toHaveBeenCalledWith({
      ...turn,
      dispatchReplyFromConfig: boundReplyDispatch ?? callerDispatch,
      replyOptions: { disableTools: true },
    });
  });
});

describe("runtimeContexts", () => {
  const scope = { channelId: "matrix", accountId: "default", capability: "approval.native" };
  function fixture() {
    const contexts = createRuntimeChannel().runtimeContexts;
    const controller = new AbortController();
    return {
      controller,
      register: (context: object) =>
        contexts.register({ ...scope, context, abortSignal: controller.signal }),
      watch: (onEvent: Parameters<typeof contexts.watch>[0]["onEvent"]) =>
        contexts.watch({ ...scope, onEvent }),
      read: () => contexts.get(scope),
    };
  }

  it("removes the stale lease abort listener after a replacement registration", () => {
    const { controller, register, read } = fixture();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const staleLease = register({ token: "stale" });
    register({ token: "replacement" });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 2);

    staleLease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);
    expect(read()).toEqual({ token: "replacement" });
  });

  it.each(["before registration", "during notification"] as const)(
    "disposes on abort %s",
    (timing) => {
      const { controller, register, watch, read } = fixture();
      const onEvent = vi.fn((event) => {
        if (timing === "during notification" && event.type === "registered") {
          controller.abort();
        }
      });
      watch(onEvent);
      if (timing === "before registration") {
        controller.abort();
      }
      const lease = register({ client: "stale" });
      expect(read()).toBeUndefined();
      expectWatcherEvents(
        onEvent,
        ...(timing === "before registration" ? [] : ["registered", "unregistered"]),
      );
      lease.dispose();
    },
  );

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const { register, watch, read } = fixture();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    watch(badWatcher);
    const unsubscribe = watch(goodWatcher);

    const lease = register({ client: "ok" });

    expect(read()).toEqual({ client: "ok" });
    lease.dispose();

    expect(read()).toBeUndefined();
    expectWatcherEvents(badWatcher, "registered", "unregistered");
    expectWatcherEvents(goodWatcher, "registered", "unregistered");
    unsubscribe();
  });
});
