import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const buildQueueDiagnosticsSnapshot = vi.hoisted(() => vi.fn());
const resolveStuckSessionWarnMs = vi.hoisted(() => vi.fn(() => 60_000));

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../infra/queue-diagnostics.js", () => ({
  buildQueueDiagnosticsSnapshot,
}));

vi.mock("../../logging/diagnostic.js", () => ({
  resolveStuckSessionWarnMs,
}));

import { diagnosticsHandlers } from "./diagnostics.js";

describe("diagnostics.queue", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    buildQueueDiagnosticsSnapshot.mockReset();
    resolveStuckSessionWarnMs.mockClear();
    buildQueueDiagnosticsSnapshot.mockReturnValue({
      ts: 123,
      stuckSessionWarnMs: 60_000,
      summary: {
        lanes: 0,
        queued: 0,
        active: 0,
        draining: 0,
        sessions: 0,
        stuckSessions: 0,
      },
      lanes: [],
      sessions: [],
    });
  });

  it("handles missing params and defaults includeIdle to false", async () => {
    const respond = vi.fn();

    await diagnosticsHandlers["diagnostics.queue"]({
      req: {} as never,
      params: undefined,
      respond: respond as never,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveStuckSessionWarnMs).toHaveBeenCalledWith(expect.any(Object));
    expect(buildQueueDiagnosticsSnapshot).toHaveBeenCalledWith({
      includeIdle: false,
      stuckSessionWarnMs: 60_000,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        stuckSessionWarnMs: 60_000,
      }),
      undefined,
    );
  });
});
