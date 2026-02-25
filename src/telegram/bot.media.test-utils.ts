import { afterEach, beforeAll, beforeEach, expect, vi, type Mock } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { onSpy, sendChatActionSpy } from "./bot.media.e2e-harness.js";

type StickerSpy = Mock<(...args: unknown[]) => unknown>;

export const cacheStickerSpy: StickerSpy = vi.fn();
export const getCachedStickerSpy: StickerSpy = vi.fn();
export const describeStickerImageSpy: StickerSpy = vi.fn();

const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;

export const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

const TELEGRAM_BOT_IMPORT_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 150_000;

let createTelegramBotRef: typeof import("./bot.js").createTelegramBot;
let replySpyRef: ReturnType<typeof vi.fn>;

export async function createBotHandler(): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  return createBotHandlerWithOptions({});
}

export async function createBotHandlerWithOptions(options: {
  proxyFetch?: typeof fetch;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
}): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  onSpy.mockClear();
  replySpyRef.mockClear();
  sendChatActionSpy.mockClear();

  const runtimeError = options.runtimeError ?? vi.fn();
  const runtimeLog = options.runtimeLog ?? vi.fn();
  createTelegramBotRef({
    token: "tok",
    testTimings: TELEGRAM_TEST_TIMINGS,
    ...(options.proxyFetch ? { proxyFetch: options.proxyFetch } : {}),
    runtime: {
      log: runtimeLog as (...data: unknown[]) => void,
      error: runtimeError as (...data: unknown[]) => void,
      exit: () => {
        throw new Error("exit");
      },
    },
  });
  const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  expect(handler).toBeDefined();
  return { handler, replySpy: replySpyRef, runtimeError };
}

export function mockTelegramFileDownload(params: {
  contentType: string;
  bytes: Uint8Array;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => params.contentType },
    arrayBuffer: async () => params.bytes.buffer,
  } as unknown as Response);
}

export function mockTelegramPngDownload(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
  } as unknown as Response);
}

beforeEach(() => {
  vi.useRealTimers();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  resolvePinnedHostnameSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
});

afterEach(() => {
  lookupMock.mockClear();
  resolvePinnedHostnameSpy?.mockRestore();
  resolvePinnedHostnameSpy = null;
});

beforeAll(async () => {
  ({ createTelegramBot: createTelegramBotRef } = await import("./bot.js"));
  const replyModule = await import("../auto-reply/reply.js");
  replySpyRef = (replyModule as unknown as { __replySpy: ReturnType<typeof vi.fn> }).__replySpy;
}, TELEGRAM_BOT_IMPORT_TIMEOUT_MS);

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: (...args: unknown[]) => cacheStickerSpy(...args),
  getCachedSticker: (...args: unknown[]) => getCachedStickerSpy(...args),
  describeStickerImage: (...args: unknown[]) => describeStickerImageSpy(...args),
}));
