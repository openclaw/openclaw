import { vi } from "vitest";

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
