import { vi } from "vitest";

// Post-attach orchestration keeps unrelated background discovery worker-free.
vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("./update-run-watcher.js", () => ({
  startUpdateRunWatcher: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  wakeUpdateRunWatcher: vi.fn(),
}));
