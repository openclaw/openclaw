import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorIMessageProvider } from "./monitor.js";

const requestMock = vi.fn();
const stopMock = vi.fn();
const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();

let config: Record<string, unknown> = {};
let notificationHandler: ((msg: { method: string; params?: unknown }) => void) | undefined;
let closeResolve: (() => void) | undefined;

vi.mock("../config/config.js", () => ({
  loadConfig: () => config,
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdis-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: vi.fn(async (opts: { onNotification?: typeof notificationHandler }) => {
    notificationHandler = opts.onNotification;
    return {
      request: (...args: unknown[]) => requestMock(...args),
      waitForClose: () =>
        new Promise<void>((resolve) => {
          closeResolve = resolve;
        }),
      stop: (...args: unknown[]) => stopMock(...args),
    };
  }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForSubscribe() {
  for (let i = 0; i < 5; i += 1) {
    if (requestMock.mock.calls.some((call) => call[0] === "watch.subscribe")) return;
    await flush();
  }
}

beforeEach(() => {
  config = {
    imessage: {},
    session: { mainKey: "main" },
    routing: {
      groupChat: { mentionPatterns: ["@clawd"], requireMention: true },
      allowFrom: [],
    },
  };
  requestMock.mockReset().mockImplementation((method: string) => {
    if (method === "watch.subscribe") return Promise.resolve({ subscription: 1 });
    return Promise.resolve({});
  });
  stopMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ messageId: "ok" });
  replyMock.mockReset().mockResolvedValue({ text: "ok" });
  updateLastRouteMock.mockReset();
  notificationHandler = undefined;
  closeResolve = undefined;
});

describe("monitorIMessageProvider", () => {
  it("skips group messages without a mention by default", async () => {
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 1,
          chat_id: 99,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello group",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("delivers group replies when mentioned", async () => {
    replyMock.mockResolvedValueOnce({ text: "yo" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 2,
          chat_id: 42,
          sender: "+15550002222",
          is_from_me: false,
          text: "@clawd ping",
          is_group: true,
          chat_name: "Lobster Squad",
          participants: ["+1555", "+1556"],
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(sendMock).toHaveBeenCalledWith(
      "chat_id:42",
      "yo",
      expect.objectContaining({ client: expect.any(Object) }),
    );
  });

  it("honors allowFrom entries", async () => {
    config = {
      ...config,
      imessage: { allowFrom: ["chat_id:101"] },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 3,
          chat_id: 202,
          sender: "+15550003333",
          is_from_me: false,
          text: "@clawd hi",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("updates last route with chat_id for direct messages", async () => {
    replyMock.mockResolvedValueOnce({ text: "ok" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
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
    closeResolve?.();
    await run;

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "imessage",
        to: "chat_id:7",
      }),
    );
  });
});
