import type { RequestClient } from "@buape/carbon";
import { vi } from "vitest";

/**
 * Shared test harness for Discord send tests.
 * Creates a mock REST client with vitest spies for each HTTP method.
 */
export function makeDiscordRest() {
  const postMock = vi.fn();
  const putMock = vi.fn();
  const getMock = vi.fn();
  const patchMock = vi.fn();
  const deleteMock = vi.fn();
  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
}

/**
 * Factory for mocking ../web/media.js in Discord send tests.
 * Usage: vi.mock("../web/media.js", async () => { const { discordWebMediaMockFactory } = await import("./send.test-harness.js"); return discordWebMediaMockFactory(); })
 */
export function discordWebMediaMockFactory() {
  return {
    loadWebMedia: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      kind: "image",
    }),
    loadWebMediaRaw: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "asset.png",
      contentType: "image/png",
      kind: "image",
    }),
  };
}
