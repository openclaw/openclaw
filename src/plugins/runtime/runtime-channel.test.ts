import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { PluginInstance } from "../plugin-instance.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const dispatchRoutedChannelTurn = vi.hoisted(() =>
  vi.fn(
    async (
      _turn: Parameters<
        typeof import("../../channels/turn/lifecycle.js").dispatchRoutedChannelTurn
      >[0],
    ) => ({ status: "handled" }),
  ),
);

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
  function createOwnedInboundFixture(observerOnly = false) {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "owned-channel" });
    registry.plugins.push(record);
    const owner = new PluginInstance("owned-channel", { record, registry });
    const channel = createRuntimeChannel();
    const delivered = vi.fn();
    return {
      owner,
      delivered,
      dispatch: (replyOptions?: GetReplyOptions) =>
        owner.run(() =>
          channel.inbound.dispatch({
            cfg: {},
            channel: "owned-channel",
            route: { agentId: "main", sessionKey: "agent:main:owned-channel:direct:test" },
            ctxPayload: { Body: "test", CommandAuthorized: false },
            delivery: { deliver: delivered },
            replyOptions:
              replyOptions ??
              (observerOnly
                ? { onModelSelected: delivered, turnAdoptionLifecycle: { onAdopted() {} } }
                : { onQueuedFollowupReplyBatch: delivered }),
          }),
        ),
    };
  }

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

  it("keeps immediate delivery live after source settlement until dispatch returns", async () => {
    const { owner, delivered, dispatch } = createOwnedInboundFixture();
    dispatchRoutedChannelTurn.mockImplementationOnce(async (turn) => {
      // Immediate execution settles its source before the dispatcher sends its final.
      await turn.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
      await turn.delivery.deliver?.({ text: "immediate answer" }, { kind: "final" });
      return { status: "handled" };
    });
    try {
      await dispatch();
      expect(delivered).toHaveBeenCalledWith({ text: "immediate answer" }, { kind: "final" });
      expect(owner.hasRetainedConsumers).toBe(false);
    } finally {
      await owner.dispose();
    }
  });

  it("does not add adoption ownership to plain source options", async () => {
    const { owner, dispatch } = createOwnedInboundFixture();
    const source = new AbortController();
    try {
      await dispatch({ abortSignal: source.signal });
      const turn = dispatchRoutedChannelTurn.mock.calls.at(-1)?.[0];
      expect(turn?.replyOptions?.abortSignal).toBe(source.signal);
      // Plain user turns detach this source signal when queued; a lifecycle would attach it.
      expect(
        turn?.turnAdoptionLifecycle ?? turn?.replyOptions?.turnAdoptionLifecycle,
      ).toBeUndefined();
      expect(owner.hasRetainedConsumers).toBe(false);
    } finally {
      await owner.dispose();
    }
  });

  it.each([false, true])("owns queued callback lifetime (observer=%s)", async (observerOnly) => {
    const { owner, delivered, dispatch } = createOwnedInboundFixture(observerOnly);
    let settle: (() => void | Promise<void>) | undefined;
    dispatchRoutedChannelTurn.mockImplementationOnce(async (turn) => {
      turn.replyOptions?.turnAdoptionLifecycle?.onDeferred?.();
      return { status: "handled" };
    });
    try {
      await dispatch();
      const queued = dispatchRoutedChannelTurn.mock.calls.at(-1)?.[0];
      if (!queued) {
        throw new Error("Dispatch did not retain the queued source");
      }
      settle = queued.replyOptions?.turnAdoptionLifecycle?.onSettled;
      expect(owner.hasRetainedConsumers).toBe(true);
      const batch = {
        kind: "queued-followup" as const,
        runId: "queued-run",
        originatingChannel: "owned-channel",
        payloads: [{ text: "answer" }],
        completion: { kind: "completed" as const },
      };
      const model = { provider: "openai", model: "qa", thinkLevel: undefined };
      const callback = observerOnly
        ? () => queued.replyOptions?.onModelSelected?.(model)
        : () => queued.replyOptions?.onQueuedFollowupReplyBatch?.(batch);
      await callback();
      expect(delivered).toHaveBeenCalledExactlyOnceWith(observerOnly ? model : batch);
      await settle?.();
      expect(owner.hasRetainedConsumers).toBe(false);
      expect(callback).toThrow("consumer is closed");
      settle = undefined;
    } finally {
      await settle?.();
      await owner.dispose();
    }
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
