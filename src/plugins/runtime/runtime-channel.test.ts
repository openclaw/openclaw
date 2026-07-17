// Runtime channel tests cover channel plugin runtime send, reply, and capability behavior.
import { getEventListeners } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireWatcherEvent(mock: ReturnType<typeof vi.fn>, index: number) {
  const event = mock.mock.calls[index]?.[0] as { type?: string } | undefined;
  if (!event) {
    throw new Error(`Expected watcher event ${index}`);
  }
  return event;
}

describe("session runtime", () => {
  it("keeps main restart recovery private in channel metadata helper results", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-channel-session-isolation-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:direct:runtime-isolation";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "channel-cycle",
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      mainRestartRecovery,
      restartRecoveryBeforeAgentReplyState: "continue",
      sessionId: "channel-session",
      updatedAt: 10,
    } as InternalSessionEntry);
    const channel = createRuntimeChannel();

    const recorded = await channel.session.recordSessionMetaFromInbound({
      createIfMissing: false,
      ctx: {
        From: "user:1",
        OriginatingChannel: "telegram",
        To: "bot:1",
      },
      sessionKey,
      storePath,
    });
    expect(recorded).not.toHaveProperty("mainRestartRecovery");
    expect(recorded).toHaveProperty("restartRecoveryBeforeAgentReplyState", "continue");
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery,
      origin: expect.objectContaining({ provider: "telegram" }),
    });

    const routed = await channel.session.updateLastRoute({
      channel: "telegram",
      sessionKey,
      storePath,
      to: "user:1",
    });
    expect(routed).not.toHaveProperty("mainRestartRecovery");
    expect(routed).toHaveProperty("restartRecoveryBeforeAgentReplyState", "continue");
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      lastChannel: "telegram",
      lastTo: "user:1",
      mainRestartRecovery,
    });
  });
});

describe("runtimeContexts", () => {
  it("registers, resolves, watches, and unregisters contexts", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get<{ client: string }>({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(onEvent).toHaveBeenCalledWith({
      type: "registered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
      context: { client: "ok" },
    });

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "unregistered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
    });

    unsubscribe();
  });

  it("auto-disposes registrations when the abort signal fires", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(
      channel.runtimeContexts.get({
        channelId: "telegram",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    lease.dispose();
  });

  it("removes its abort listener when the lease is disposed", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);

    lease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("removes the stale lease abort listener after a replacement registration", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const staleLease = channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "stale" },
      abortSignal: controller.signal,
    });
    channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "replacement" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 2);

    // Channel plugins dispose the previous lease after registering its replacement,
    // so the stale token check must not skip listener cleanup.
    staleLease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);
    expect(
      channel.runtimeContexts.get({
        channelId: "whatsapp",
        accountId: "default",
        capability: "connection.controller",
      }),
    ).toEqual({ token: "replacement" });
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "stale" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const channel = createRuntimeChannel();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: badWatcher,
    });
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: goodWatcher,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(requireWatcherEvent(badWatcher, 0).type).toBe("registered");
    expect(requireWatcherEvent(goodWatcher, 0).type).toBe("registered");

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(badWatcher, 1).type).toBe("unregistered");
    expect(requireWatcherEvent(goodWatcher, 1).type).toBe("unregistered");
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(onEvent, 0).type).toBe("registered");
    expect(requireWatcherEvent(onEvent, 1).type).toBe("unregistered");

    lease.dispose();
  });
});
