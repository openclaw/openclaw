import { beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduleRestartSentinelWake:
    vi.fn<typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake>(),
  prepareLatestUpdateRestartSentinel: vi.fn<
    typeof import("./server-update-sentinel.js").prepareLatestUpdateRestartSentinel
  >(async () => null),
}));

export const restartSentinelMocks = mocks;

vi.mock("./server-restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-restart-sentinel.js")>()),
  scheduleRestartSentinelWake: mocks.scheduleRestartSentinelWake,
}));

vi.mock("./server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-update-sentinel.js")>()),
  prepareLatestUpdateRestartSentinel: mocks.prepareLatestUpdateRestartSentinel,
}));

beforeEach(() => {
  mocks.scheduleRestartSentinelWake.mockClear();
  mocks.prepareLatestUpdateRestartSentinel.mockReset().mockResolvedValue(null);
});

// Post-attach orchestration keeps unrelated background discovery worker-free.
vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../sessions/session-state-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/session-state-events.js")>()),
  sweepSessionStateWatchNotices: vi.fn(),
}));

vi.mock("./update-run-watcher.js", () => ({
  startUpdateRunWatcher: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  wakeUpdateRunWatcher: vi.fn(),
}));
