import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      channels: {
        messenger: {
          enabled: true,
          pageAccessToken: "test-token",
          appSecret: "test-secret",
          verifyToken: "test-verify",
        },
      },
    }),
  };
});

vi.mock("../infra/channel-activity.js", () => ({
  recordChannelActivity: vi.fn(),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const { sendMessageMessenger, sendMediaMessenger, sendSenderAction, getUserProfile } =
  await import("./send.js");

describe("sendMessageMessenger", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a text message", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "mid.123" }),
    });

    const result = await sendMessageMessenger("12345", "Hello!");

    expect(result.messageId).toBe("mid.123");
    expect(result.chatId).toBe("12345");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/me/messages");
    const body = JSON.parse(opts.body);
    expect(body.recipient.id).toBe("12345");
    expect(body.message.text).toBe("Hello!");
  });

  it("strips messenger: prefix from recipient", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "mid.456" }),
    });

    const result = await sendMessageMessenger("messenger:12345", "Hi");

    expect(result.chatId).toBe("12345");
  });

  it("chunks long messages", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "mid.789" }),
    });

    const longText = "x".repeat(5000);
    await sendMessageMessenger("12345", longText);

    // Should have been split into multiple API calls
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("throws on empty message without media", async () => {
    await expect(sendMessageMessenger("12345", "")).rejects.toThrow("non-empty");
  });

  it("throws on API error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    });

    await expect(sendMessageMessenger("12345", "Hello")).rejects.toThrow("400");
  });
});

describe("sendMediaMessenger", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a media attachment", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "mid.media" }),
    });

    const result = await sendMediaMessenger("12345", "https://example.com/image.png");

    expect(result.messageId).toBe("mid.media");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message.attachment.type).toBe("image");
    expect(body.message.attachment.payload.url).toBe("https://example.com/image.png");
  });

  it("uses specified media type", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: "mid.video" }),
    });

    await sendMediaMessenger("12345", "https://example.com/video.mp4", { mediaType: "video" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message.attachment.type).toBe("video");
  });
});

describe("sendSenderAction", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a sender action", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await sendSenderAction("12345", "typing_on");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipient.id).toBe("12345");
    expect(body.sender_action).toBe("typing_on");
  });

  it("does not throw on failure (non-fatal)", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    await expect(sendSenderAction("12345", "typing_on")).resolves.toBeUndefined();
  });
});

describe("getUserProfile", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns profile with snake_case fields", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        first_name: "John",
        last_name: "Doe",
        profile_pic: "https://example.com/pic.jpg",
      }),
    });

    const profile = await getUserProfile("12345");

    expect(profile).toEqual({
      first_name: "John",
      last_name: "Doe",
      profile_pic: "https://example.com/pic.jpg",
    });
  });

  it("returns null on API error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const profile = await getUserProfile("12345");

    expect(profile).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const profile = await getUserProfile("12345");

    expect(profile).toBeNull();
  });
});
