import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

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
});
