import { beforeEach, expect, it, vi } from "vitest";
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

it("warms existing configured stores and skips absent databases", async () => {
  mocks.stat.mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
  await prewarmGatewaySessionHistory(config);
  expect(mocks.prepare.mock.calls.map(([storePath]) => storePath)).toEqual([
    "/synthetic/main/sessions.json",
    "/synthetic/research/sessions.json",
  ]);
  expect(mocks.prewarm).toHaveBeenCalledExactlyOnceWith({
    agentId: "research",
    path: "/synthetic/research/openclaw-agent.sqlite",
  });
});

it("does no store discovery for warm connections or cancelled work", async () => {
  mocks.cold.mockReturnValue(false);
  await prewarmGatewaySessionHistory(config, { onlyIfCold: true });
  await prewarmGatewaySessionHistory(config, { isCancelled: () => true });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.stat).not.toHaveBeenCalled();
  expect(mocks.prewarm).not.toHaveBeenCalled();
});

it("continues after discovery failure and rechecks cancellation after discovery", async () => {
  mocks.prepare.mockRejectedValueOnce(new Error("store unavailable"));
  await expect(prewarmGatewaySessionHistory(config)).resolves.toBeUndefined();
  expect(mocks.prewarm).toHaveBeenCalledOnce();
  mocks.prewarm.mockClear();
  let cancelled = false;
  mocks.stat.mockImplementationOnce(async () => {
    cancelled = true;
    return { isFile: () => true };
  });
  await prewarmGatewaySessionHistory(config, { isCancelled: () => cancelled });
  expect(mocks.prewarm).not.toHaveBeenCalled();
});
