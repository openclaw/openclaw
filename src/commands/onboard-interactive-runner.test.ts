import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import { launchTuiCli } from "../tui/tui-launch.js";
import { runGuidedOnboardingHandoff } from "./onboard-interactive-runner.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));
// mock-isolation: Prove the bootstrap lookup without preparing a real agent workspace.
vi.mock("../agents/workspace.js", () => ({ DEFAULT_BOOTSTRAP_FILENAME: "BOOTSTRAP.md" }));
// mock-isolation: Observe the handoff without opening an interactive terminal client.
vi.mock("../tui/tui-launch.js", () => ({ launchTuiCli: vi.fn(async () => {}) }));
// mock-isolation: Verify terminal restoration order without touching the test process TTY.
vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("../agents/workspace.js");
  vi.doUnmock("../tui/tui-launch.js");
  vi.doUnmock("../../packages/terminal-core/src/restore.js");
});

it.each([
  { local: false, bootstrap: false, agentId: undefined },
  { local: true, bootstrap: false, agentId: undefined },
  { local: false, bootstrap: true, agentId: "coordinator" },
])("launches the real hatch owner with its workspace and route: %j", async (scenario) => {
  vi.mocked(existsSync).mockReturnValue(scenario.bootstrap);
  await runGuidedOnboardingHandoff(
    {
      workspace: "/fixture/approved-workspace",
      next: "hatch",
      local: scenario.local,
      ...(scenario.agentId ? { agentId: scenario.agentId } : {}),
    },
    {},
    {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("Unexpected exit");
      },
    },
    {},
  );
  expect(existsSync).toHaveBeenCalledWith("/fixture/approved-workspace/BOOTSTRAP.md");
  expect(launchTuiCli).toHaveBeenCalledExactlyOnceWith({
    deliver: false,
    ...(scenario.local ? { local: true } : {}),
    ...(scenario.agentId ? { session: `agent:${scenario.agentId}:main` } : {}),
    ...(scenario.bootstrap ? { message: expect.any(String) } : {}),
  });
  expect(restoreTerminalState).toHaveBeenNthCalledWith(1, "guided hatch tui", {
    resumeStdinIfPaused: false,
  });
  expect(restoreTerminalState).toHaveBeenNthCalledWith(2, "post guided hatch tui", {
    resumeStdinIfPaused: false,
  });
});
