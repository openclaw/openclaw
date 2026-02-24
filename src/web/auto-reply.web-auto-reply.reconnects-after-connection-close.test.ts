import { beforeAll, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createWebListenerFactoryCapture,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

installWebAutoReplyTestHomeHooks();

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function startMonitorWebChannel(params: {
  monitorWebChannelFn: (...args: unknown[]) => Promise<unknown>;
  listenerFactory: unknown;
  sleep: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
  heartbeatSeconds?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  reconnect?: { initialMs: number; maxMs: number; maxAttempts: number; factor: number };
}) {
  const runtime = createRuntime();
  const controller = new AbortController();
  const run = params.monitorWebChannelFn(
    false,
    params.listenerFactory as never,
    true,
    async () => ({ text: "ok" }),
    runtime as never,
    params.signal ?? controller.signal,
    {
      heartbeatSeconds: params.heartbeatSeconds ?? 1,
      messageTimeoutMs: params.messageTimeoutMs,
      watchdogCheckMs: params.watchdogCheckMs,
      reconnect: params.reconnect ?? { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
      sleep: params.sleep,
    },
  );

  return { runtime, controller, run };
}

function makeInboundMessage(params: {
  body: string;
  from: string;
  to: string;
  id?: string;
  timestamp?: number;
  sendComposing: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  sendMedia: ReturnType<typeof vi.fn>;
}): WebInboundMessage {
  return {
    body: params.body,
    from: params.from,
    to: params.to,
    id: params.id,
    timestamp: params.timestamp,
    conversationId: params.from,
    accountId: "default",
    chatType: "direct",
    chatId: params.from,
    sendComposing: params.sendComposing as unknown as WebInboundMessage["sendComposing"],
    reply: params.reply as unknown as WebInboundMessage["reply"],
    sendMedia: params.sendMedia as unknown as WebInboundMessage["sendMedia"],
  };
}

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  // Ensure test-harness `vi.mock(...)` hooks are registered before importing the module under test.
  let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(() => formatEnvelopeTimestamp(d, " America/Los_Angeles ")).not.toThrow();
  });

  it("handles reconnect progress and max-attempt stop behavior", async () => {
    for (const scenario of [
      {
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: false,
        expectedError: "Retry 1",
      },
      {
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: true,
        expectedError: "max attempts reached",
      },
    ]) {
      const closeResolvers: Array<() => void> = [];
      const sleep = vi.fn(async () => {});
      const listenerFactory = vi.fn(async () => {
        const onClose = new Promise<void>((res) => {
          closeResolvers.push(res);
        });
        return { close: vi.fn(), onClose };
      });
      const { runtime, controller, run } = startMonitorWebChannel({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
        reconnect: scenario.reconnect,
      });

      await Promise.resolve();
      expect(listenerFactory).toHaveBeenCalledTimes(1);

      closeResolvers.shift()?.();
      await vi.waitFor(
        () => {
          expect(listenerFactory).toHaveBeenCalledTimes(scenario.expectedCallsAfterFirstClose);
        },
        { timeout: 250, interval: 2 },
      );

      if (scenario.closeTwiceAndFinish) {
        closeResolvers.shift()?.();
        await run;
      } else {
        controller.abort();
        closeResolvers.shift()?.();
        await Promise.resolve();
        await run;
      }

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(scenario.expectedError));
    }
  });
  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const closeResolvers: Array<(reason: unknown) => void> = [];
      let capturedOnMessage:
        | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
        | undefined;
      const listenerFactory = vi.fn(
        async (opts: {
          onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
        }) => {
          capturedOnMessage = opts.onMessage;
          let resolveClose: (reason: unknown) => void = () => {};
          const onClose = new Promise<unknown>((res) => {
            resolveClose = res;
            closeResolvers.push(res);
          });
          return {
            close: vi.fn(),
            onClose,
            signalClose: (reason?: unknown) => resolveClose(reason),
          };
        },
      );
      const { controller, run } = startMonitorWebChannel({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
        heartbeatSeconds: 60,
        messageTimeoutMs: 30,
        watchdogCheckMs: 5,
      });

      await Promise.resolve();
      expect(listenerFactory).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        () => {
          expect(capturedOnMessage).toBeTypeOf("function");
        },
        { timeout: 250, interval: 2 },
      );

      const reply = vi.fn().mockResolvedValue(undefined);
      const sendComposing = vi.fn();
      const sendMedia = vi.fn();

      // The watchdog only needs `lastMessageAt` to be set. Don't await full message
      // processing here since it can schedule timers and become flaky under load.
      void capturedOnMessage?.(
        makeInboundMessage({
          body: "hi",
          from: "+1",
          to: "+2",
          id: "m1",
          sendComposing,
          reply,
          sendMedia,
        }),
      );

      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(listenerFactory).toHaveBeenCalledTimes(2);
        },
        { timeout: 250, interval: 2 },
      );

      controller.abort();
      closeResolvers[1]?.({ status: 499, isLoggedOut: false });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes inbound messages without batching and preserves timestamps", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      const originalMax = process.getMaxListeners();
      process.setMaxListeners?.(1); // force low to confirm bump

      const store = await makeSessionStore({
        main: { sessionId: "sid", updatedAt: Date.now() },
      });

      try {
        const sendMedia = vi.fn();
        const reply = vi.fn().mockResolvedValue(undefined);
        const sendComposing = vi.fn();
        const resolver = vi.fn().mockResolvedValue({ text: "ok" });

        const capture = createWebListenerFactoryCapture();

        setLoadConfigMock(() => ({
          agents: {
            defaults: {
              envelopeTimezone: "utc",
            },
          },
          session: { store: store.storePath },
        }));

        await monitorWebChannel(false, capture.listenerFactory as never, false, resolver);
        const capturedOnMessage = capture.getOnMessage();
        expect(capturedOnMessage).toBeDefined();

        // Two messages from the same sender with fixed timestamps
        await capturedOnMessage?.(
          makeInboundMessage({
            body: "first",
            from: "+1",
            to: "+2",
            id: "m1",
            timestamp: 1735689600000, // Jan 1 2025 00:00:00 UTC
            sendComposing,
            reply,
            sendMedia,
          }),
        );
        await capturedOnMessage?.(
          makeInboundMessage({
            body: "second",
            from: "+1",
            to: "+2",
            id: "m2",
            timestamp: 1735693200000, // Jan 1 2025 01:00:00 UTC
            sendComposing,
            reply,
            sendMedia,
          }),
        );

        expect(resolver).toHaveBeenCalledTimes(2);
        const firstArgs = resolver.mock.calls[0][0];
        const secondArgs = resolver.mock.calls[1][0];
        const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"));
        const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"));
        const firstPattern = escapeRegExp(firstTimestamp);
        const secondPattern = escapeRegExp(secondTimestamp);
        expect(firstArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${firstPattern}\\] \\[openclaw\\] first`),
        );
        expect(firstArgs.Body).not.toContain("second");
        expect(secondArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${secondPattern}\\] \\[openclaw\\] second`),
        );
        expect(secondArgs.Body).not.toContain("first");

        // Max listeners bumped to avoid warnings in multi-instance test runs
        expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
      } finally {
        process.setMaxListeners?.(originalMax);
        await store.cleanup();
      }
    });
  });
});
