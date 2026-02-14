import { vi } from "vitest";

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
    } as unknown as import("@buape/carbon").RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
}
