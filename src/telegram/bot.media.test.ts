import { describe, expect, it, vi } from "vitest";

const useSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const sendChatActionSpy = vi.fn();

type ApiStub = {
  config: { use: (arg: unknown) => void };
  sendChatAction: typeof sendChatActionSpy;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
};

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    on = onSpy;
    stop = stopSpy;
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});

describe("telegram inbound media", () => {
  it("downloads media via file_path (no file.download)", async () => {
    const { createTelegramBot } = await import("./bot.js");
    const replyModule = await import("../auto-reply/reply.js");
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;

    onSpy.mockReset();
    replySpy.mockReset();
    sendChatActionSpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    createTelegramBot({
      token: "tok",
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls[0]?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () =>
          new Uint8Array([0xff, 0xd8, 0xff, 0x00]).buffer,
      } as Response);

    await handler({
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
        date: 1736380800, // 2025-01-09T00:00:00Z
      },
      me: { username: "clawdis_bot" },
      getFile: async () => ({ file_path: "photos/1.jpg" }),
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottok/photos/1.jpg",
    );
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("<media:image>");

    fetchSpy.mockRestore();
  });

  it("prefers proxyFetch over global fetch", async () => {
    const { createTelegramBot } = await import("./bot.js");

    onSpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi
      .spyOn(globalThis, "fetch" as never)
      .mockImplementation(() => {
        throw new Error("global fetch should not be called");
      });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as Response);

    createTelegramBot({
      token: "tok",
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls[0]?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        message_id: 2,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "clawdis_bot" },
      getFile: async () => ({ file_path: "photos/2.jpg" }),
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottok/photos/2.jpg",
    );

    globalFetchSpy.mockRestore();
  });

  it("logs a handler error when getFile returns no file_path", async () => {
    const { createTelegramBot } = await import("./bot.js");
    const replyModule = await import("../auto-reply/reply.js");
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;

    onSpy.mockReset();
    replySpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

    createTelegramBot({
      token: "tok",
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls[0]?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        message_id: 3,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "clawdis_bot" },
      getFile: async () => ({}),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledTimes(1);
    const msg = String(runtimeError.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("handler failed:");
    expect(msg).toContain("file_path");

    fetchSpy.mockRestore();
  });
});
