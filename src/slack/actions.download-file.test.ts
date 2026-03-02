import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn();

vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

const { downloadSlackFile } = await import("./actions.js");

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({ file: {} })),
    },
  } as unknown as WebClient & {
    files: {
      info: ReturnType<typeof vi.fn>;
    };
  };
}

function makeSlackFileInfo(overrides?: Record<string, unknown>) {
  return {
    id: "F123",
    name: "image.png",
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
    ...overrides,
  };
}

function makeResolvedSlackMedia() {
  return {
    path: "/tmp/image.png",
    contentType: "image/png",
    placeholder: "[Slack file: image.png]",
  };
}

function expectNoMediaDownload(result: Awaited<ReturnType<typeof downloadSlackFile>>) {
  expect(result).toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
}

function expectResolveSlackMediaCalledWithDefaults() {
  expect(resolveSlackMedia).toHaveBeenCalledWith({
    files: [
      {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private: undefined,
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    ],
    token: "xoxb-test",
    maxBytes: 1024,
  });
}

describe("downloadSlackFile", () => {
  beforeEach(() => {
    resolveSlackMedia.mockReset();
  });

  it("returns null when files.info has no private download URL", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("downloads via resolveSlackMedia using fresh files.info metadata", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo(),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expectResolveSlackMediaCalledWithDefaults();
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("returns null when channel scope definitely mismatches file shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({ channels: ["C999"] }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expectNoMediaDownload(result);
  });

  it("returns null when thread scope definitely mismatches file share thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: {
          private: {
            C123: [{ ts: "111.111", thread_ts: "111.111" }],
          },
        },
      }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expectNoMediaDownload(result);
  });

  it("keeps legacy behavior when file metadata does not expose channel/thread shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo(),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
    expectResolveSlackMediaCalledWithDefaults();
  });
});
