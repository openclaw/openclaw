import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (_opts: unknown, req: { path?: string }) =>
    req.path === "/"
      ? {
          enabled: true,
          running: true,
          pid: 1,
          cdpPort: 18800,
          chosenBrowser: "chrome",
          userDataDir: "/tmp/openclaw",
          color: "blue",
          headless: true,
          attachOnly: false,
        }
      : {},
  ),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => {
    try {
      await action();
    } catch (err) {
      onError(err);
    }
  },
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser manage start timeout option", () => {
  function createProgram() {
    const program = new Command();
    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile")
      .option("--json", "Output JSON", false)
      .option("--timeout <ms>", "Timeout in ms", "30000");
    const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;
    registerBrowserManageCommands(browser, parentOpts);
    return program;
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("uses parent --timeout for browser start instead of hardcoded 15s", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "--timeout", "60000", "start"], { from: "user" });

    const startCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/start",
    ) as [Record<string, unknown>, { path?: string }, unknown] | undefined;

    expect(startCall).toBeDefined();
    expect(startCall?.[0]).toMatchObject({ timeout: "60000" });
    expect(startCall?.[2]).toBeUndefined();
  });
});
