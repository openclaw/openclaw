import { describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "./send-api.js";

function createMockSock() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg-1" } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createWebSendApi", () => {
  describe("sendMessage", () => {
    it("uses provided fileName for document payloads", async () => {
      const sock = createMockSock();
      const api = createWebSendApi({ sock, defaultAccountId: "default" });

      await api.sendMessage(
        "1234567890",
        "here is your report",
        Buffer.from("pdf-data"),
        "application/pdf",
        { fileName: "report.pdf" },
      );

      const payload = sock.sendMessage.mock.calls[0][1];
      expect(payload).toHaveProperty("document");
      expect(payload).toHaveProperty("fileName", "report.pdf");
      expect(payload).toHaveProperty("caption", "here is your report");
    });

    it('defaults to "file" when no fileName provided for documents', async () => {
      const sock = createMockSock();
      const api = createWebSendApi({ sock, defaultAccountId: "default" });

      await api.sendMessage("1234567890", "a file", Buffer.from("data"), "application/pdf");

      const payload = sock.sendMessage.mock.calls[0][1];
      expect(payload).toHaveProperty("document");
      expect(payload).toHaveProperty("fileName", "file");
    });

    it("sends image payloads without fileName", async () => {
      const sock = createMockSock();
      const api = createWebSendApi({ sock, defaultAccountId: "default" });

      await api.sendMessage("1234567890", "a photo", Buffer.from("img"), "image/jpeg");

      const payload = sock.sendMessage.mock.calls[0][1];
      expect(payload).toHaveProperty("image");
      expect(payload).not.toHaveProperty("fileName");
    });

    it("sends video payloads with gifPlayback when set", async () => {
      const sock = createMockSock();
      const api = createWebSendApi({ sock, defaultAccountId: "default" });

      await api.sendMessage("1234567890", "a video", Buffer.from("vid"), "video/mp4", {
        gifPlayback: true,
      });

      const payload = sock.sendMessage.mock.calls[0][1];
      expect(payload).toHaveProperty("video");
      expect(payload).toHaveProperty("gifPlayback", true);
    });
  });
});
