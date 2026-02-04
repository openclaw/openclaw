import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./session.js", () => {
  const createWaSocket = vi.fn(
    async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
      const sock = { ws: { close: vi.fn() } };
      if (opts?.onQr) {
        setImmediate(() => opts.onQr?.("qr-data"));
      }
      return sock;
    },
  );
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status,
  );
  const webAuthExists = vi.fn(async () => false);
  const readWebSelfId = vi.fn(() => ({ e164: null, jid: null }));
  const logoutWeb = vi.fn(async () => true);
  return {
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    webAuthExists,
    readWebSelfId,
    logoutWeb,
  };
});

vi.mock("./qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

const { startWebLoginWithQr, startWebLoginWithPairingCode, waitForWebLogin } =
  await import("./login-qr.js");
const { createWaSocket, waitForWaConnection, logoutWeb } = await import("./session.js");

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnection
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result.connected).toBe(true);
    expect(createWaSocket).toHaveBeenCalledTimes(2);
    expect(logoutWeb).not.toHaveBeenCalled();
  });

  describe("startWebLoginWithPairingCode", () => {
    it("returns error for invalid phone number (too short)", async () => {
      const result = await startWebLoginWithPairingCode({ phoneNumber: "123" });
      expect(result.pairingCode).toBeUndefined();
      expect(result.message).toContain("Invalid phone number");
    });

    it("returns error for invalid phone number (too long)", async () => {
      const result = await startWebLoginWithPairingCode({ phoneNumber: "1234567890123456" });
      expect(result.pairingCode).toBeUndefined();
      expect(result.message).toContain("Invalid phone number");
    });

    it("strips non-numeric characters from phone number", async () => {
      const mockRequestPairingCode = vi.fn().mockResolvedValue("123-456");
      createWaSocket.mockResolvedValueOnce({
        ws: { close: vi.fn() },
        requestPairingCode: mockRequestPairingCode,
      });
      waitForWaConnection.mockReturnValueOnce(new Promise(() => {}));

      const result = await startWebLoginWithPairingCode({ phoneNumber: "+1 (415) 555-1234" });

      expect(mockRequestPairingCode).toHaveBeenCalledWith("14155551234");
      expect(result.pairingCode).toBe("123-456");
    });

    it("returns pairing code on success", async () => {
      const mockRequestPairingCode = vi.fn().mockResolvedValue("ABC-123");
      createWaSocket.mockResolvedValueOnce({
        ws: { close: vi.fn() },
        requestPairingCode: mockRequestPairingCode,
      });
      waitForWaConnection.mockReturnValueOnce(new Promise(() => {}));

      const result = await startWebLoginWithPairingCode({ phoneNumber: "14155551234" });

      expect(result.pairingCode).toBe("ABC-123");
      expect(result.message).toContain("ABC-123");
    });

    it("returns error when requestPairingCode is not available", async () => {
      createWaSocket.mockResolvedValueOnce({
        ws: { close: vi.fn() },
      });
      waitForWaConnection.mockReturnValueOnce(new Promise(() => {}));

      const result = await startWebLoginWithPairingCode({ phoneNumber: "14155551234" });

      expect(result.pairingCode).toBeUndefined();
      expect(result.message).toContain("not supported");
    });

    it("returns error when requestPairingCode throws", async () => {
      const mockRequestPairingCode = vi.fn().mockRejectedValue(new Error("Network error"));
      createWaSocket.mockResolvedValueOnce({
        ws: { close: vi.fn() },
        requestPairingCode: mockRequestPairingCode,
      });
      waitForWaConnection.mockReturnValueOnce(new Promise(() => {}));

      const result = await startWebLoginWithPairingCode({ phoneNumber: "14155551234" });

      expect(result.pairingCode).toBeUndefined();
      expect(result.message).toContain("Failed to get pairing code");
    });
  });
});
