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
            profile: "openclaw",
            running: true,
            pid: 1,
            cdpPort: 18800,
            chosenBrowser: "chrome",
            userDataDir: "/tmp/openclaw",
            color: "#FF4500",
            headless: true,
            attachOnly: false,
          }
        : { ok: true },
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

describe("browser start --headless", () => {
  function createProgram() {
    const { program, browser, parentOpts } = createBrowserProgram();
    registerBrowserManageCommands(browser, parentOpts);
    return program;
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtimeLog.mockClear();
  });

  it("passes headless=true query param when --headless flag is provided", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "start", "--headless"], { from: "user" });

    const startCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/start",
    ) as [unknown, { path?: string; query?: Record<string, string> }] | undefined;

    expect(startCall).toBeDefined();
    expect(startCall?.[1]?.query).toMatchObject({ headless: "true" });
  });

  it("does not pass headless query param without --headless flag", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "start"], { from: "user" });

    const startCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/start",
    ) as [unknown, { path?: string; query?: Record<string, string> }] | undefined;

    expect(startCall).toBeDefined();
    expect(startCall?.[1]?.query).toBeUndefined();
  });

  it("logs headless indicator in output when browser is headless", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "start", "--headless"], { from: "user" });

    expect(mocks.runtimeLog).toHaveBeenCalled();
    const logOutput = mocks.runtimeLog.mock.calls.map((c) => c[0]).join("\n");
    expect(logOutput).toContain("(headless)");
  });
});
