import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";

const mocks = vi.hoisted(() => {
  const runtimeLog = vi.fn();
  const runtimeError = vi.fn();
  const runtimeExit = vi.fn();
  return {
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
    runtimeLog,
    runtimeError,
    runtimeExit,
    runtime: {
      log: runtimeLog,
      error: runtimeError,
      exit: runtimeExit,
    },
  };
});

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => await action().catch(onError),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser manage start timeout option", () => {
  function createProgram() {
    const { program, browser, parentOpts } = createBrowserProgram();
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserManageCommands(browser, parentOpts);
    return program;
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtimeLog.mockClear();
    mocks.runtimeError.mockClear();
    mocks.runtimeExit.mockClear();
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

  it("shortens reset-profile trash paths in human output", async () => {
    const home = os.homedir();
    mocks.callBrowserRequest.mockImplementationOnce(async () => ({
      moved: true,
      from: `${home}/.openclaw/browser/default`,
      to: `${home}/.Trash/openclaw-browser-default`,
    }));

    const program = createProgram();
    await program.parseAsync(["browser", "reset-profile"], { from: "user" });

    expect(mocks.runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("(~/.Trash/openclaw-browser-default)"),
    );
    expect(mocks.runtimeLog).not.toHaveBeenCalledWith(
      expect.stringContaining(`${home}/.Trash/openclaw-browser-default`),
    );
  });
});
