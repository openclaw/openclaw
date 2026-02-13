import { beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivity = vi.fn();
vi.mock("../../infra/channel-activity.js", () => ({
  recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
}));

import { createWebSendApi } from "./send-api.js";

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(async () => ({ key: { id: "msg-1" } }));
  const sendPresenceUpdate = vi.fn(async () => {});
  const api = createWebSendApi({
    sock: { sendMessage, sendPresenceUpdate },
    defaultAccountId: "main",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "invoice.pdf",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to default document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "file",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
  });
});
