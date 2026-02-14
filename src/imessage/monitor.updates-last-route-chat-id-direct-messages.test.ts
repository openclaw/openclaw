import { beforeAll, describe, expect, it } from "vitest";
import {
  flush,
  getCloseResolve,
  getNotificationHandler,
  getReplyMock,
  getRequestMock,
  getStopMock,
  getUpdateLastRouteMock,
  installMonitorIMessageProviderTestHooks,
  waitForSubscribe,
} from "./monitor.test-harness.js";

installMonitorIMessageProviderTestHooks();

let monitorIMessageProvider: typeof import("./monitor.js").monitorIMessageProvider;

beforeAll(async () => {
  ({ monitorIMessageProvider } = await import("./monitor.js"));
});

const replyMock = getReplyMock();
const requestMock = getRequestMock();
const stopMock = getStopMock();
const updateLastRouteMock = getUpdateLastRouteMock();

describe("monitorIMessageProvider", () => {
  it("updates last route with sender handle for direct messages", async () => {
    replyMock.mockResolvedValueOnce({ text: "ok" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    getNotificationHandler()?.({
      method: "message",
      params: {
        message: {
          id: 4,
          chat_id: 7,
          sender: "+15550004444",
          is_from_me: false,
          text: "hey",
          is_group: false,
        },
      },
    });

    await flush();
    getCloseResolve()?.();
    await run;

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          channel: "imessage",
          to: "+15550004444",
        }),
      }),
    );
  });

  it("does not trigger unhandledRejection when aborting during shutdown", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "watch.subscribe") {
        return Promise.resolve({ subscription: 1 });
      }
      if (method === "watch.unsubscribe") {
        return Promise.reject(new Error("imsg rpc closed"));
      }
      return Promise.resolve({});
    });

    const abortController = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const run = monitorIMessageProvider({
        abortSignal: abortController.signal,
      });
      await waitForSubscribe();
      await flush();

      abortController.abort();
      await flush();

      getCloseResolve()?.();
      await run;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(stopMock).toHaveBeenCalled();
  });
});
