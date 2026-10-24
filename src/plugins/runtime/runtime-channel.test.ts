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
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const channel = createRuntimeChannel();
      withPluginRuntimePluginScope({ pluginId: "legacy-runtime-timestamp-test" }, () => {
        expect(channel.session.readSessionUpdatedAt(scope)).toBe(60_000);
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("readSessionUpdatedAtAsync"),
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      );
    } finally {
      warning.mockRestore();
    }
  });
});

describe("inbound dispatch", () => {
  it("removes event custody before invoking the host-bound reply dispatcher", async () => {
    const callback = vi.fn();
    const counts = { tool: 0, block: 0, final: 0 };
    const dispatch = vi.fn(async () => ({ queuedFinal: false, counts }));
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

  it("removes the stale lease abort listener after a replacement registration", () => {
    const contexts = createRuntimeChannel().runtimeContexts;
    const connectionScope = {
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
    };
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const staleLease = contexts.register({
      ...connectionScope,
      context: { token: "stale" },
      abortSignal: controller.signal,
    });
    contexts.register({
      ...connectionScope,
      context: { token: "replacement" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 2);

    // Plugins dispose the old lease only after its replacement is registered.
    staleLease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);
    expect(contexts.get(connectionScope)).toEqual({ token: "replacement" });
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const contexts = createRuntimeChannel().runtimeContexts;
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    contexts.watch({ ...scope, onEvent });

    const lease = contexts.register({
      ...scope,
      context: { client: "stale" },
      abortSignal: controller.signal,
    });

    expect(contexts.get(scope)).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const contexts = createRuntimeChannel().runtimeContexts;
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    contexts.watch({ ...scope, onEvent: badWatcher });
    const unsubscribe = contexts.watch({ ...scope, onEvent: goodWatcher });

    const lease = contexts.register({ ...scope, context: { client: "ok" } });

    expect(contexts.get(scope)).toEqual({ client: "ok" });
    expectWatcherEvents(badWatcher, "registered");
    expectWatcherEvents(goodWatcher, "registered");

    lease.dispose();

    expect(contexts.get(scope)).toBeUndefined();
    expectWatcherEvents(badWatcher, "registered", "unregistered");
    expectWatcherEvents(goodWatcher, "registered", "unregistered");
    unsubscribe();
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const contexts = createRuntimeChannel().runtimeContexts;
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    contexts.watch({ ...scope, onEvent });

    const lease = contexts.register({
      ...scope,
      context: { client: "ok" },
      abortSignal: controller.signal,
    });

    expect(contexts.get(scope)).toBeUndefined();
    expectWatcherEvents(onEvent, "registered", "unregistered");

    lease.dispose();
  });
});
