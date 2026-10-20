import { beforeEach, expect, it, vi } from "vitest";
import { maintenanceLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  prepare: vi.fn(),
  cold: vi.fn(),
  prewarm: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: { stat: mocks.stat } }));
vi.mock("../config/sessions/session-sqlite-target.js", () => ({
  prepareSqliteTargetFromSessionStorePath: mocks.prepare,
}));
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  isSessionHistoryWorkerCold: mocks.cold,
  prewarmSessionHistoryWorker: mocks.prewarm,
}));
import { prewarmGatewaySessionHistory } from "./server-history-prewarm.js";

const config: OpenClawConfig = {
  agents: { entries: { main: {}, research: {} } },
  session: { store: "/synthetic/{agentId}/sessions.json" },
};

beforeEach(() => {
  mocks.cold.mockReset().mockReturnValue(true);
  mocks.prewarm.mockReset().mockResolvedValue(undefined);
  mocks.stat.mockReset().mockResolvedValue({ isFile: () => true });
  mocks.prepare.mockReset().mockImplementation(async (_storePath, options) => ({
    agentId: options.agentId,
    path: `/synthetic/${options.agentId}/openclaw-agent.sqlite`,
  }));
});

it.each(["absent", "unavailable", "warm", "cancelled", "cancelled after discovery"])(
  "prewarms only eligible stores when the first store is %s",
  async (scenario) => {
    let cancelled = scenario === "cancelled";
    if (scenario === "absent") {
      mocks.stat.mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
    } else if (scenario === "unavailable") {
      mocks.prepare.mockRejectedValueOnce(new Error("store unavailable"));
    } else if (scenario === "warm") {
      mocks.cold.mockReturnValue(false);
    } else if (scenario === "cancelled after discovery") {
      mocks.stat.mockImplementationOnce(async () => {
        cancelled = true;
        return { isFile: () => true };
      });
    }
    await expect(
      prewarmGatewaySessionHistory(config, {
        onlyIfCold: scenario === "warm",
        isCancelled: () => cancelled,
      }),
    ).resolves.toBeUndefined();
    const skipped = scenario === "warm" || scenario === "cancelled";
    const discovered = skipped
      ? []
      : scenario === "cancelled after discovery"
        ? ["/synthetic/main/sessions.json"]
        : ["/synthetic/main/sessions.json", "/synthetic/research/sessions.json"];
    expect(mocks.prepare.mock.calls.map(([storePath]) => storePath)).toEqual(discovered);
    if (scenario === "absent" || scenario === "unavailable") {
      expect(mocks.prewarm).toHaveBeenCalledExactlyOnceWith({
        agentId: "research",
        path: "/synthetic/research/openclaw-agent.sqlite",
      });
    } else {
      expect(mocks.prewarm).not.toHaveBeenCalled();
    }
    if (skipped) {
      expect(mocks.stat).not.toHaveBeenCalled();
    }
  },
);

it("prepares a cold maintenance reader even when foreground history is warm", async () => {
  mocks.cold.mockImplementation((lane) => lane === maintenanceLane);
  await prewarmGatewaySessionHistory(config, { onlyIfCold: true, includeMaintenance: true });
  expect(mocks.prewarm.mock.calls.filter(([, lane]) => lane === maintenanceLane)).toEqual([
    [{ agentId: "main", path: "/synthetic/main/openclaw-agent.sqlite" }, maintenanceLane],
    [{ agentId: "research", path: "/synthetic/research/openclaw-agent.sqlite" }, maintenanceLane],
  ]);
});
