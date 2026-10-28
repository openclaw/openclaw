// Covers the console subsystem filter the TUI owns while it draws the terminal.
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loggingState } from "../logging/state.js";
import { createTuiConsoleOwnership, runTui } from "./tui.js";

const { setConsoleSubsystemFilter } = vi.hoisted(() => ({
  setConsoleSubsystemFilter: vi.fn(),
}));
vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    setConsoleSubsystemFilter: (...args: Parameters<typeof actual.setConsoleSubsystemFilter>) => {
      setConsoleSubsystemFilter(...args);
      return actual.setConsoleSubsystemFilter(...args);
    },
  };
});

afterEach(() => {
  loggingState.consoleSubsystemFilter = null;
  setConsoleSubsystemFilter.mockClear();
  vi.restoreAllMocks();
});

it.each<[string, string[] | null]>([
  ["no prior filter", null],
  ["an existing prior filter", ["gateway"]],
])("restores %s after claiming and reclaiming the terminal", (_label, prior) => {
  loggingState.consoleSubsystemFilter = prior;
  const ownership = createTuiConsoleOwnership();

  ownership.claim();
  expect(loggingState.consoleSubsystemFilter).toEqual(["__openclaw_tui_quiet__"]);

  // Suspending for an external command hands the terminal back temporarily.
  ownership.release();
  expect(loggingState.consoleSubsystemFilter).toEqual(prior);

  ownership.claim();
  expect(loggingState.consoleSubsystemFilter).toEqual(["__openclaw_tui_quiet__"]);
  ownership.release();
  expect(loggingState.consoleSubsystemFilter).toEqual(prior);
});

it("quiets the console for a remote TUI and restores it when startup fails", async () => {
  loggingState.consoleSubsystemFilter = null;

  // Port 1 is never a Gateway, so the remote lifecycle fails before the first frame.
  await expect(
    runTui({ url: "ws://127.0.0.1:1", config: {} as OpenClawConfig, session: "agent:dev:probe" }),
  ).rejects.toThrow();

  expect(setConsoleSubsystemFilter.mock.calls).toEqual([[["__openclaw_tui_quiet__"]], [null]]);
  expect(loggingState.consoleSubsystemFilter).toBeNull();
});
