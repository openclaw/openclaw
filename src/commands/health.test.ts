import { describe, expect, it, vi, beforeEach } from "vitest";

import { healthCommand } from "./health.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ web: {}, inbound: {} }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  loadSessionStore: vi.fn(() => ({
    "+1555": { updatedAt: Date.now() - 60_000 },
  })),
}));

const waitForWaConnection = vi.fn();
const webAuthExists = vi.fn();

vi.mock("../web/session.js", () => ({
  createWaSocket: vi.fn(async () => ({ ws: { close: vi.fn() }, ev: { on: vi.fn() } })),
  waitForWaConnection: (...args: unknown[]) => waitForWaConnection(...args),
  webAuthExists: (...args: unknown[]) => webAuthExists(...args),
  getStatusCode: vi.fn(() => 440),
  getWebAuthAgeMs: () => 5000,
  logWebSelfId: vi.fn(),
}));

vi.mock("../web/reconnect.js", () => ({
  resolveHeartbeatSeconds: () => 60,
}));

describe("healthCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outputs JSON when linked and connect succeeds", async () => {
    webAuthExists.mockResolvedValue(true);
    waitForWaConnection.mockResolvedValue(undefined);

    await healthCommand({ json: true, timeoutMs: 5000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const logged = runtime.log.mock.calls[0][0] as string;
    const parsed = JSON.parse(logged);
    expect(parsed.web.linked).toBe(true);
    expect(parsed.web.connect.ok).toBe(true);
    expect(parsed.sessions.count).toBe(1);
  });

  it("exits non-zero when not linked", async () => {
    webAuthExists.mockResolvedValue(false);
    await healthCommand({ json: true }, runtime as never);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when connect fails", async () => {
    webAuthExists.mockResolvedValue(true);
    waitForWaConnection.mockRejectedValueOnce({ output: { statusCode: 440 } });

    await healthCommand({ json: true }, runtime as never);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    const logged = runtime.log.mock.calls[0][0] as string;
    const parsed = JSON.parse(logged);
    expect(parsed.web.connect.ok).toBe(false);
    expect(parsed.web.connect.status).toBe(440);
  });
});
