import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQuantdServerMock } = vi.hoisted(() => ({
  startQuantdServerMock: vi.fn(),
}));

vi.mock("../quantd/server.js", () => ({
  startQuantdServer: (options: unknown) => startQuantdServerMock(options),
}));

import { startGatewayQuantdSidecar } from "./server-startup-quantd.js";

describe("startGatewayQuantdSidecar", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    startQuantdServerMock.mockReset();
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_QUANTD_ENABLED;
    delete process.env.OPENCLAW_QUANTD_HOST;
    delete process.env.OPENCLAW_QUANTD_PORT;
    delete process.env.OPENCLAW_QUANTD_SOCKET_PATH;
    delete process.env.OPENCLAW_QUANTD_WAL_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when quantd sidecar is disabled", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(startGatewayQuantdSidecar({ log })).resolves.toBeNull();

    expect(startQuantdServerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("starts quantd sidecar with env overrides when enabled", async () => {
    process.env.OPENCLAW_QUANTD_ENABLED = "1";
    process.env.OPENCLAW_QUANTD_HOST = "127.0.0.9";
    process.env.OPENCLAW_QUANTD_PORT = "21001";
    process.env.OPENCLAW_QUANTD_WAL_PATH = "/tmp/openclaw-quantd.jsonl";
    startQuantdServerMock.mockResolvedValue({
      baseUrl: "http://127.0.0.9:21001",
      socketPath: undefined,
      walPath: "/tmp/openclaw-quantd.jsonl",
      close: vi.fn(),
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const handle = await startGatewayQuantdSidecar({ log });

    expect(startQuantdServerMock).toHaveBeenCalledWith({
      host: "127.0.0.9",
      port: 21001,
      walPath: "/tmp/openclaw-quantd.jsonl",
      socketPath: undefined,
    });
    expect(handle).toMatchObject({
      baseUrl: "http://127.0.0.9:21001",
      walPath: "/tmp/openclaw-quantd.jsonl",
    });
    expect(log.info).toHaveBeenCalledWith(
      "quantd sidecar started at http://127.0.0.9:21001 (wal=/tmp/openclaw-quantd.jsonl)",
    );
  });

  it("falls back to the default port when env port is invalid", async () => {
    process.env.OPENCLAW_QUANTD_ENABLED = "1";
    process.env.OPENCLAW_QUANTD_PORT = "invalid";
    startQuantdServerMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:19891",
      socketPath: undefined,
      walPath: "/tmp/quantd.jsonl",
      close: vi.fn(),
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayQuantdSidecar({ log });

    expect(startQuantdServerMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 19891,
      walPath: undefined,
      socketPath: undefined,
    });
    expect(log.warn).toHaveBeenCalledWith('invalid OPENCLAW_QUANTD_PORT "invalid"; using 19891');
  });
});
