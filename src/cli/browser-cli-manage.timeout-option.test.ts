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
      writeStdout: vi.fn((value: string) =>
        runtimeLog(value.endsWith("\n") ? value.slice(0, -1) : value),
      ),
      writeJson: vi.fn((value: unknown, space = 2) =>
        runtimeLog(JSON.stringify(value, null, space)),
      ),
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

  it("uses a longer built-in timeout for browser status", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "status"], { from: "user" });

    const statusCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/",
    ) as [Record<string, unknown>, { path?: string }, { timeoutMs?: number }] | undefined;

    expect(statusCall?.[2]).toEqual({ timeoutMs: 45_000 });
  });

  it("uses a longer built-in timeout for browser tabs", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "tabs"], { from: "user" });

    const tabsCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/tabs",
    ) as [Record<string, unknown>, { path?: string }, { timeoutMs?: number }] | undefined;

    expect(tabsCall?.[2]).toEqual({ timeoutMs: 45_000 });
  });

  it("uses a longer built-in timeout for browser profiles", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const profilesCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/profiles",
    ) as [Record<string, unknown>, { path?: string }, { timeoutMs?: number }] | undefined;

    expect(profilesCall?.[2]).toEqual({ timeoutMs: 45_000 });
  });

  it("uses a longer built-in timeout for browser open", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "open", "https://example.com"], { from: "user" });

    const openCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/tabs/open",
    ) as [Record<string, unknown>, { path?: string }, { timeoutMs?: number }] | undefined;

    expect(openCall?.[2]).toEqual({ timeoutMs: 45_000 });
  });
});
