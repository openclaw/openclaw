import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import { renderQrPngBase64 } from "./qr-image.js";
import { createWaSocket, logoutWeb, waitForWaConnection } from "./session.js";

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
  renderQrPngBase64: vi.fn(async (qr: string) => `base64-${qr}`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const renderQrPngBase64Mock = vi.mocked(renderQrPngBase64);

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("refreshes the active QR when WhatsApp rotates refs during login", async () => {
    let emitQr: ((qr: string) => void) | undefined;
    createWaSocketMock.mockImplementationOnce(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        emitQr = opts?.onQr;
        const sock = { ws: { close: vi.fn() } };
        if (opts?.onQr) {
          setImmediate(() => opts.onQr?.("qr-first"));
        }
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockReturnValue(new Promise<void>(() => {}));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    emitQr?.("qr-second");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const refreshed = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(refreshed.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(renderQrPngBase64Mock).toHaveBeenCalledWith("qr-second");
  });

  it("preserves an early QR emitted before the active login is registered", async () => {
    createWaSocketMock.mockImplementationOnce(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-early");
        return { ws: { close: vi.fn() } } as never;
      },
    );
    waitForWaConnectionMock.mockReturnValue(new Promise<void>(() => {}));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.message).toContain("QR already active");
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
