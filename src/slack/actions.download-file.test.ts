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
      file: {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    });
    resolveSlackMedia.mockResolvedValueOnce([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        placeholder: "[Slack file: image.png]",
      },
    ]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
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
    expect(result).toEqual({
      path: "/tmp/image.png",
      contentType: "image/png",
      placeholder: "[Slack file: image.png]",
    });
  });

  it("returns null when channel scope definitely mismatches file shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
        channels: ["C999"],
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("returns null when thread scope definitely mismatches file share thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
        shares: {
          private: {
            C123: [{ ts: "111.111", thread_ts: "111.111" }],
          },
        },
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("keeps legacy behavior when file metadata does not expose channel/thread shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    });
    resolveSlackMedia.mockResolvedValueOnce([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        placeholder: "[Slack file: image.png]",
      },
    ]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expect(result).toEqual({
      path: "/tmp/image.png",
      contentType: "image/png",
      placeholder: "[Slack file: image.png]",
    });
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
  });
});
