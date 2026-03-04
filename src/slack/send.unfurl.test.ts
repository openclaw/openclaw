import { describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  })),
}));

const { sendMessageSlack } = await import("./send.js");
const { resolveSlackAccount } = await import("./accounts.js");

function createTestClient() {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as any;
}

describe("sendMessageSlack unfurl config", () => {
  it("does not include unfurl flags when config is unset (preserves Slack defaults)", async () => {
    const client = createTestClient();
    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      client,
    });

    const payload = client.chat.postMessage.mock.calls[0][0];
    expect(payload).not.toHaveProperty("unfurl_links");
    expect(payload).not.toHaveProperty("unfurl_media");
  });

  it("passes unfurl_links: false when config sets unfurlLinks to false", async () => {
    vi.mocked(resolveSlackAccount).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      botToken: "xoxb-test",
      botTokenSource: "config",
      appTokenSource: "none",
      config: { unfurlLinks: false },
    } as any);

    const client = createTestClient();
    await sendMessageSlack("channel:C123", "check https://example.com", {
      token: "xoxb-test",
      client,
    });

    const payload = client.chat.postMessage.mock.calls[0][0];
    expect(payload.unfurl_links).toBe(false);
    expect(payload).not.toHaveProperty("unfurl_media");
  });

  it("passes unfurl_media: false when config sets unfurlMedia to false", async () => {
    vi.mocked(resolveSlackAccount).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      botToken: "xoxb-test",
      botTokenSource: "config",
      appTokenSource: "none",
      config: { unfurlMedia: false },
    } as any);

    const client = createTestClient();
    await sendMessageSlack("channel:C123", "see https://example.com/img.png", {
      token: "xoxb-test",
      client,
    });

    const payload = client.chat.postMessage.mock.calls[0][0];
    expect(payload).not.toHaveProperty("unfurl_links");
    expect(payload.unfurl_media).toBe(false);
  });

  it("passes both unfurl flags when both are configured", async () => {
    vi.mocked(resolveSlackAccount).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      botToken: "xoxb-test",
      botTokenSource: "config",
      appTokenSource: "none",
      config: { unfurlLinks: false, unfurlMedia: false },
    } as any);

    const client = createTestClient();
    await sendMessageSlack("channel:C123", "see https://example.com", {
      token: "xoxb-test",
      client,
    });

    const payload = client.chat.postMessage.mock.calls[0][0];
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("allows explicitly enabling unfurling via config", async () => {
    vi.mocked(resolveSlackAccount).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      botToken: "xoxb-test",
      botTokenSource: "config",
      appTokenSource: "none",
      config: { unfurlLinks: true, unfurlMedia: true },
    } as any);

    const client = createTestClient();
    await sendMessageSlack("channel:C123", "see https://example.com", {
      token: "xoxb-test",
      client,
    });

    const payload = client.chat.postMessage.mock.calls[0][0];
    expect(payload.unfurl_links).toBe(true);
    expect(payload.unfurl_media).toBe(true);
  });
});
