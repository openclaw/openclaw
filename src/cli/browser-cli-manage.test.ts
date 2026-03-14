import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";

const mocks = vi.hoisted(() => {
  const runtimeLog = vi.fn();
  const runtimeError = vi.fn();
  const runtimeExit = vi.fn();
  return {
    callBrowserRequest: vi.fn<
      (
        opts: unknown,
        req: { path?: string },
        runtimeOpts?: { timeoutMs?: number },
      ) => Promise<Record<string, unknown>>
    >(async () => ({})),
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

function createProgram() {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserManageCommands(browser, parentOpts);
  return program;
}

describe("browser manage output", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtimeLog.mockClear();
    mocks.runtimeError.mockClear();
    mocks.runtimeExit.mockClear();
  });

  it("shows chrome-mcp transport for existing-session status without fake CDP fields", async () => {
    mocks.callBrowserRequest.mockImplementation(async (_opts: unknown, req: { path?: string }) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "chrome-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = mocks.runtimeLog.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    mocks.callBrowserRequest.mockImplementation(async (_opts: unknown, req: { path?: string }) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "chrome-live",
                driver: "existing-session",
                transport: "chrome-mcp",
                running: true,
                tabCount: 2,
                isDefault: false,
                isRemote: false,
                cdpPort: null,
                cdpUrl: null,
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = mocks.runtimeLog.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("shows chrome-mcp transport after creating an existing-session profile", async () => {
    mocks.callBrowserRequest.mockImplementation(async (_opts: unknown, req: { path?: string }) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl: null,
            color: "#00AA00",
            isRemote: false,
          }
        : {},
    );

    const program = createProgram();
    await program.parseAsync(
      ["browser", "create-profile", "--name", "chrome-live", "--driver", "existing-session"],
      { from: "user" },
    );

    const output = mocks.runtimeLog.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });
});
