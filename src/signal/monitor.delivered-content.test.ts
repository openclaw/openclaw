import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
} from "./monitor.tool-result.test-harness.js";
import type { SignalEventHandlerDeps } from "./monitor/event-handler.types.js";

const capturedEventHandlerDeps = vi.hoisted(() => ({
  value: undefined as SignalEventHandlerDeps | undefined,
}));

vi.mock("./monitor/event-handler.js", () => ({
  createSignalEventHandler: vi.fn((deps: SignalEventHandlerDeps) => {
    capturedEventHandlerDeps.value = deps;
    return async () => {};
  }),
}));

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const { sendMock, streamMock } = getSignalToolResultTestMocks();

describe("signal delivered content metadata", () => {
  beforeEach(() => {
    capturedEventHandlerDeps.value = undefined;
  });

  it("preserves chunk boundaries when building deliveredContent", async () => {
    const abortController = new AbortController();
    streamMock.mockImplementationOnce(async () => {
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    const deps = capturedEventHandlerDeps.value;
    expect(deps?.deliverReplies).toBeTypeOf("function");

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({ messageId: "signal-msg-1" })
      .mockResolvedValueOnce({ messageId: "signal-msg-2" });

    const result = await deps!.deliverReplies({
      replies: [{ text: "hello world" }],
      target: "+15550001111",
      baseUrl: "http://127.0.0.1:8080",
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((code: number): never => {
          throw new Error(`exit ${code}`);
        }) as (code: number) => never,
      },
      maxBytes: 8 * 1024 * 1024,
      textLimit: 6,
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toBe("hello");
    expect(sendMock.mock.calls[1]?.[1]).toBe("world");
    expect(result).toMatchObject({
      delivered: true,
      messageId: "signal-msg-2",
      deliveredContent: "hello\nworld",
    });
  });
});
