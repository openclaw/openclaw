import { describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "./send-api.js";

describe("createWebSendApi", () => {
  function makeApi() {
    const sendMessage = vi.fn(async () => ({ key: { id: "m1" } }));
    const sendPresenceUpdate = vi.fn(async () => {});
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "default",
    });
    return { api, sendMessage };
  }

  it("uses provided fileName for document payloads", async () => {
    const { api, sendMessage } = makeApi();
    await api.sendMessage("+1555", "report", Buffer.from("pdf"), "application/pdf", {
      fileName: "report.pdf",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "report.pdf",
      }),
    );
  });

  it("falls back to 'file' when fileName is not provided", async () => {
    const { api, sendMessage } = makeApi();
    await api.sendMessage("+1555", "blob", Buffer.from("bin"), "application/octet-stream");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "file",
      }),
    );
  });
});
