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

vi.mock("./browser-cli-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-cli-shared.js")>();
  return {
    ...actual,
    callBrowserRequest: mocks.callBrowserRequest,
  };
});

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
});
