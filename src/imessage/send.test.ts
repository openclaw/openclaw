import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageIMessage } from "./send.js";

const requestMock = vi.fn();
const stopMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: vi.fn().mockResolvedValue({
    request: (...args: unknown[]) => requestMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
  }),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("data"),
    contentType: "image/jpeg",
  }),
}));

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockResolvedValue({
    path: "/tmp/imessage-media.jpg",
    contentType: "image/jpeg",
  }),
}));

describe("sendMessageIMessage", () => {
  beforeEach(() => {
    requestMock.mockReset().mockResolvedValue({ ok: true });
    stopMock.mockReset().mockResolvedValue(undefined);
  });

  it("sends to chat_id targets", async () => {
    await sendMessageIMessage("chat_id:123", "hi");
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(requestMock).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.any(Object),
    );
    expect(params.chat_id).toBe(123);
    expect(params.text).toBe("hi");
  });

  it("applies sms service prefix", async () => {
    await sendMessageIMessage("sms:+1555", "hello");
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.service).toBe("sms");
    expect(params.to).toBe("+1555");
  });

  it("adds file attachment with placeholder text", async () => {
    await sendMessageIMessage("chat_id:7", "", { mediaUrl: "http://x/y.jpg" });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.file).toBe("/tmp/imessage-media.jpg");
    expect(params.text).toBe("<media:image>");
  });
});
