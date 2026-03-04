import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySignalCliLogLine } from "./daemon.js";
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

  it("returns ok=false when /check fails and JSON-RPC is also unavailable", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });
    signalRpcRequestMock.mockRejectedValueOnce(new Error("connection refused"));

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
  });

  it("returns ok=true via JSON-RPC fallback when REST check is unavailable", async () => {
    // Regression test for: signal-cli JSON-RPC-only daemons where
    // GET /api/v1/check returns 404/fetch-failed but POST /api/v1/rpc works.
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: null,
      error: "fetch failed",
    });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.24" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(null);
    expect(res.version).toBe("0.13.24");
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log (even if emitted on stderr)", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats WARN/ERROR as error", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});
