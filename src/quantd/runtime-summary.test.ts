import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createQuantdClientMock, snapshotMock } = vi.hoisted(() => ({
  createQuantdClientMock: vi.fn(),
  snapshotMock: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createQuantdClient: (options: unknown) => createQuantdClientMock(options),
}));

import { getQuantdRuntimeSummary } from "./runtime-summary.js";

describe("getQuantdRuntimeSummary", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_QUANTD_ENABLED;
    delete process.env.OPENCLAW_QUANTD_HOST;
    delete process.env.OPENCLAW_QUANTD_PORT;
    delete process.env.OPENCLAW_QUANTD_SOCKET_PATH;
    snapshotMock.mockReset();
    createQuantdClientMock.mockReset();
    createQuantdClientMock.mockReturnValue({
      snapshot: snapshotMock,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns disabled summary when quantd is not enabled", async () => {
    await expect(getQuantdRuntimeSummary()).resolves.toMatchObject({
      enabled: false,
      status: "disabled",
    });

    expect(createQuantdClientMock).not.toHaveBeenCalled();
  });

  it("returns ok summary from quantd snapshot when enabled", async () => {
    process.env.OPENCLAW_QUANTD_ENABLED = "1";
    process.env.OPENCLAW_QUANTD_HOST = "127.0.0.9";
    process.env.OPENCLAW_QUANTD_PORT = "21001";
    snapshotMock.mockResolvedValue({
      health: {
        status: "ok",
        reasons: [],
        lastHeartbeatAt: "2026-03-14T00:00:00.000Z",
      },
      wal: { path: "/tmp/quantd.jsonl", records: 5 },
      replay: { lastSequence: 5, replayedRecords: 5 },
      metrics: {
        heartbeats: 2,
        marketEvents: 2,
        orderEvents: 1,
        duplicateEvents: 0,
      },
      recentEvents: [{ sequence: 5, kind: "order_event", receivedAt: "x", summary: "filled" }],
    });

    await expect(getQuantdRuntimeSummary({ timeoutMs: 4321 })).resolves.toMatchObject({
      enabled: true,
      status: "ok",
      baseUrl: "http://127.0.0.9:21001",
      health: {
        status: "ok",
      },
      metrics: {
        heartbeats: 2,
        orderEvents: 1,
      },
      wal: {
        path: "/tmp/quantd.jsonl",
      },
    });

    expect(createQuantdClientMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.9:21001",
      socketPath: undefined,
      timeoutMs: 4321,
    });
  });

  it("returns unreachable summary when quantd snapshot fetch fails", async () => {
    process.env.OPENCLAW_QUANTD_ENABLED = "1";
    snapshotMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(getQuantdRuntimeSummary()).resolves.toMatchObject({
      enabled: true,
      status: "unreachable",
      error: expect.stringContaining("ECONNREFUSED"),
    });
  });
});
