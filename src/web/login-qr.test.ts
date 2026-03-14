import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetActiveWebLoginsForTest, startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import { renderQrPngBase64 } from "./qr-image.js";
import { createWaSocket, logoutWeb, waitForWaConnection } from "./session.js";

vi.mock("qrcode-terminal", () => ({
  default: {
    generate: vi.fn((_data: string, _opts: unknown, cb?: (output: string) => void) => {
      cb?.("ascii-qr");
    }),
  },
}));

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

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const renderQrPngBase64Mock = vi.mocked(renderQrPngBase64);

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveWebLoginsForTest();
    waitForWaConnectionMock.mockResolvedValue(undefined);
  });

  it("reuses an in-progress forced login instead of resetting it on poll", async () => {
    createWaSocketMock.mockImplementationOnce(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        const sock = { ws: { close: vi.fn() } };
        setTimeout(() => opts?.onQr?.("delayed-qr"), 25);
        return sock;
      },
    );

    const first = startWebLoginWithQr({ force: true, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await startWebLoginWithQr({ force: true, timeoutMs: 5000 });

    expect(second.message).toContain("Still preparing the WhatsApp QR");
    expect(createWaSocketMock).toHaveBeenCalledTimes(1);

    const resolved = await first;
    expect(resolved.qrDataUrl).toBe("data:image/png;base64,base64");
    expect(resolved.qrAscii).toBe("ascii-qr");
    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");
    expect(start.qrAscii).toBe("ascii-qr");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("can return terminal QR without generating a PNG", async () => {
    const result = await startWebLoginWithQr({ timeoutMs: 5000, includeImage: false });

    expect(result.qrDataUrl).toBeUndefined();
    expect(result.qrAscii).toBe("ascii-qr");
    expect(renderQrPngBase64Mock).not.toHaveBeenCalled();
  });
});
