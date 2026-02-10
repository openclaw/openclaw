import { describe, expect, it, vi } from "vitest";

let capturedFetchImpl: unknown;

vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(async (opts: { fetchImpl?: unknown }) => {
    capturedFetchImpl = opts.fetchImpl;
    return { buffer: Buffer.from("img"), contentType: "image/png", fileName: "a.png" };
  }),
}));

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: vi.fn(async () => ({
    path: "/tmp/saved.png",
    contentType: "image/png",
  })),
}));

const { resolveMediaList } = await import("./message-utils.js");

function makeMessage(
  attachments: Array<{ url: string; filename: string; content_type: string; id: string }>,
) {
  return { attachments } as Parameters<typeof resolveMediaList>[0];
}

describe("resolveMediaList proxy support", () => {
  it("passes fetchImpl to fetchRemoteMedia when provided", async () => {
    capturedFetchImpl = undefined;
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const msg = makeMessage([
      {
        url: "https://cdn.discordapp.com/a.png",
        filename: "a.png",
        content_type: "image/png",
        id: "1",
      },
    ]);

    await resolveMediaList(msg, 8 * 1024 * 1024, fakeFetch);

    expect(capturedFetchImpl).toBe(fakeFetch);
  });

  it("passes undefined fetchImpl when no proxy is configured", async () => {
    capturedFetchImpl = "sentinel";
    const msg = makeMessage([
      {
        url: "https://cdn.discordapp.com/b.png",
        filename: "b.png",
        content_type: "image/png",
        id: "2",
      },
    ]);

    await resolveMediaList(msg, 8 * 1024 * 1024);

    expect(capturedFetchImpl).toBeUndefined();
  });
});
