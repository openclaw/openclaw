import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import {
  createWaSocket,
  logoutWeb,
  waitForCredsSaveQueue,
  waitForWaConnection,
} from "./session.js";

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
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode ??
      (err as { status?: number })?.status,
  );
  const webAuthExists = vi.fn(async () => false);
  const readWebSelfId = vi.fn(() => ({ e164: null, jid: null }));
  const logoutWeb = vi.fn(async () => true);
  const waitForCredsSaveQueue = vi.fn(async () => {});
  return {
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    webAuthExists,
    readWebSelfId,
    logoutWeb,
    waitForCredsSaveQueue,
  };
});

vi.mock("./qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const waitForCredsSaveQueueMock = vi.mocked(waitForCredsSaveQueue);

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } }, date: new Date() })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
    expect(waitForCredsSaveQueueMock).toHaveBeenCalledTimes(1);
    expect(waitForCredsSaveQueueMock).toHaveBeenCalledWith(expect.any(String));
  });

  it("drains creds queue before clearing auth on logged-out errors", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      error: { output: { statusCode: 401 } },
      date: new Date(),
    });

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });
    expect(result.connected).toBe(false);
    expect(result.message).toContain("logged out");

    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(waitForCredsSaveQueueMock).toHaveBeenCalledTimes(1);
    expect(waitForCredsSaveQueueMock).toHaveBeenCalledWith(expect.any(String));
    expect(logoutWebMock).toHaveBeenCalledTimes(1);

    const firstSocket = (await createWaSocketMock.mock.results[0]?.value) as
      | { ws?: { close: ReturnType<typeof vi.fn> } }
      | undefined;
    if (!firstSocket?.ws?.close) {
      throw new Error("expected login socket close spy");
    }

    expect(firstSocket.ws.close).toHaveBeenCalled();
    const closeOrder = firstSocket.ws.close.mock.invocationCallOrder[0];
    const waitOrder = waitForCredsSaveQueueMock.mock.invocationCallOrder[0];
    const logoutOrder = logoutWebMock.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(waitOrder);
    expect(waitOrder).toBeLessThan(logoutOrder);
  });
});
