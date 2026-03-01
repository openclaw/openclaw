import { describe, expect, it, vi } from "vitest";
import {
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// ---------------------------------------------------------------------------
// Hook-runner mock – must be declared before `await import("./monitor.js")` so
// that the module loads with our mock already in place.
// ---------------------------------------------------------------------------

// Mutable state: each test swaps in its own fake runner via `setFakeRunner`.
let currentRunner: {
  hasHooks: ReturnType<typeof vi.fn>;
  runMessageSending: ReturnType<typeof vi.fn>;
  runMessageSent: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => currentRunner,
}));

// Import monitor AFTER harness mocks + hook-runner mock are wired.
await import("./monitor.js");

const { sendMock, streamMock } = getSignalToolResultTestMocks();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
const SENDER = "+15550001111";
const REPLY_TEXT = "outbound hook reply";

/** Hook names this test cares about for outbound hooks. */
const OUTBOUND_HOOKS = new Set(["message_sending", "message_sent"]);

/**
 * Build a minimal fake HookRunner.
 *
 * By default `hasHooks` only reports true for `message_sending` / `message_sent`
 * so that other hooks (e.g. `message_received`) don't attempt to call methods
 * that aren't on this stub.
 */
function makeRunner(opts: {
  hasHooksFn?: (name: string) => boolean;
  sendingResult?: { cancel?: boolean } | null;
  sendingError?: Error;
}) {
  return {
    hasHooks: vi.fn(
      (name: string) => opts.hasHooksFn?.(name) ?? OUTBOUND_HOOKS.has(name),
    ),
    runMessageSending: vi.fn(() =>
      opts.sendingError
        ? Promise.reject(opts.sendingError)
        : Promise.resolve(opts.sendingResult ?? undefined),
    ),
    runMessageSent: vi.fn(() => Promise.resolve(undefined)),
  };
}

async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<Parameters<(typeof import("./monitor.js"))["monitorSignalProvider"]>[0]>;
}) {
  const { monitorSignalProvider } = await import("./monitor.js");
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }: { onEvent: (e: unknown) => unknown }) => {
    for (const payload of params.payloads) {
      await onEvent({ event: "receive", data: JSON.stringify(payload) });
    }
    abortController.abort();
  });
  await monitorSignalProvider({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts,
  });
  await flush();
}

function inboundPayload(text: string) {
  return {
    envelope: {
      sourceNumber: SENDER,
      sourceName: "Ada",
      timestamp: Date.now(),
      dataMessage: { message: text },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("monitorSignalProvider – outbound message_sending / message_sent hooks", () => {
  it("fires message_sending with correct payload and context before sendMessageSignal", async () => {
    const runner = makeRunner({});
    currentRunner = runner;

    sendMock.mockResolvedValue(undefined);
    const { replyMock } = getSignalToolResultTestMocks();
    replyMock.mockResolvedValue({ text: REPLY_TEXT });

    await receiveSignalPayloads({ payloads: [inboundPayload("ping")] });

    expect(runner.runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        to: SENDER,
        content: expect.stringContaining(REPLY_TEXT),
        metadata: expect.objectContaining({ channel: "signal" }),
      }),
      expect.objectContaining({ channelId: "signal" }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT call sendMessageSignal when message_sending returns { cancel: true }", async () => {
    const runner = makeRunner({ sendingResult: { cancel: true } });
    currentRunner = runner;

    const { replyMock } = getSignalToolResultTestMocks();
    replyMock.mockResolvedValue({ text: REPLY_TEXT });

    await receiveSignalPayloads({ payloads: [inboundPayload("ping")] });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("fires message_sent with success: true after successful send", async () => {
    const runner = makeRunner({});
    currentRunner = runner;

    sendMock.mockResolvedValue(undefined);
    const { replyMock } = getSignalToolResultTestMocks();
    replyMock.mockResolvedValue({ text: REPLY_TEXT });

    await receiveSignalPayloads({ payloads: [inboundPayload("ping")] });

    expect(runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: SENDER,
        content: expect.stringContaining(REPLY_TEXT),
        success: true,
      }),
      expect.objectContaining({ channelId: "signal" }),
    );
  });

  it("fires message_sent with success: false and error when sendMessageSignal throws", async () => {
    const runner = makeRunner({});
    currentRunner = runner;

    const errorMsg = "signal send failure";
    sendMock.mockRejectedValue(new Error(errorMsg));
    const { replyMock } = getSignalToolResultTestMocks();
    replyMock.mockResolvedValue({ text: REPLY_TEXT });

    // The error is caught by the event handler, so monitor doesn't reject.
    await receiveSignalPayloads({ payloads: [inboundPayload("ping")] });

    expect(runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: SENDER,
        success: false,
        error: errorMsg,
      }),
      expect.objectContaining({ channelId: "signal" }),
    );
  });
});
