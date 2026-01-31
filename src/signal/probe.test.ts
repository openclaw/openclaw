import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeSignal } from "./probe.js";

const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();

vi.mock("./client.js", () => ({
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

describe("probeSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts version from {version} result", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
  });

  it("returns ok=false when /check fails", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
  });
});
