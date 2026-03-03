import { describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ tui: { deliver: true } })),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../tui/tui.js", () => ({
  runTui: vi.fn(async () => {}),
}));

describe("tui-cli --deliver config", () => {
  it("should load config and use tui.deliver as default", async () => {
    const { loadConfig } = await import("../config/config.js");
    const { runTui } = await import("../tui/tui.js");

    // Create a mock program and command
    const mockAction = vi.fn();
    const mockCommand = {
      command: vi.fn(() => mockCommand),
      description: vi.fn(() => mockCommand),
      option: vi.fn(() => mockCommand),
      addHelpText: vi.fn(() => mockCommand),
      action: (fn: () => Promise<void>) => {
        mockAction(fn);
      },
    };
    const mockProgram = {
      command: vi.fn(() => mockCommand),
    };

    // Register the CLI
    const { registerTuiCli } = await import("./tui-cli.js");
    registerTuiCli(mockProgram as unknown as { command: () => unknown });

    // Get the action function
    const actionFn = mockAction.mock.calls[0][0];

    // Call with no --deliver flag (should use config value)
    await actionFn({ historyLimit: "200" });

    // Verify config was loaded
    expect(loadConfig).toHaveBeenCalled();

    // Verify runTui was called with config value (true)
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: true,
      }),
    );
  });
});
