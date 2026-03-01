import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSlackBlockTestMocks } from "./blocks.test-helpers.js";

// --- Module mocks (must precede dynamic import) ---
installSlackBlockTestMocks();
const fetchWithSsrFGuard = vi.fn(
  async (params: { url: string; init?: RequestInit }) =>
    ({
      response: await fetch(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }) as const,
);

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuard(...(args as [params: { url: string; init?: RequestInit }])),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn(async () => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
}));

const { sendMessageSlack } = await import("./send.js");

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

function createUploadTestClient(): UploadTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://uploads.slack.test/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves bare user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D99RESOLVED",
        files: [expect.objectContaining({ id: "F001", title: "screenshot.png" })],
      }),
    );
  });

  it("resolves prefixed user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "chart", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/chart.png",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/report.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://uploads.slack.test/upload",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.slack.test/upload",
        proxy: "env",
        auditContext: "slack-upload-file",
      }),
    );
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      }),
    );
  });
});
