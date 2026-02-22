import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onSpy } from "./bot.media.e2e-harness.js";

let handler: (ctx: Record<string, unknown>) => Promise<void>;
let replySpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const { createTelegramBot } = await import("./bot.js");
  const replyModule = await import("../auto-reply/reply.js");
  replySpy = (replyModule as unknown as { __replySpy: ReturnType<typeof vi.fn> }).__replySpy;

  onSpy.mockClear();
  createTelegramBot({ token: "tok" });
  const registeredHandler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  expect(registeredHandler).toBeDefined();
  handler = registeredHandler;
});

beforeEach(() => {
  replySpy.mockClear();
});

function expectSingleReplyPayload(replySpy: ReturnType<typeof vi.fn>) {
  expect(replySpy).toHaveBeenCalledTimes(1);
  return replySpy.mock.calls[0][0] as Record<string, unknown>;
}

describe("telegram inbound media", () => {
  const _INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;
  it(
    "includes location text and ctx fields for pins",
    async () => {
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 5,
          caption: "Meet here",
          date: 1736380800,
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            horizontal_accuracy: 12,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      const payload = expectSingleReplyPayload(replySpy);
      expect(payload.Body).toContain("Meet here");
      expect(payload.Body).toContain("48.858844");
      expect(payload.LocationLat).toBe(48.858844);
      expect(payload.LocationLon).toBe(2.294351);
      expect(payload.LocationSource).toBe("pin");
      expect(payload.LocationIsLive).toBe(false);
    },
    _INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "captures venue fields for named places",
    async () => {
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 6,
          date: 1736380800,
          venue: {
            title: "Eiffel Tower",
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      const payload = expectSingleReplyPayload(replySpy);
      expect(payload.Body).toContain("Eiffel Tower");
      expect(payload.LocationName).toBe("Eiffel Tower");
      expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
      expect(payload.LocationSource).toBe("place");
    },
    _INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );
});
