import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";
import type { CliRuntimeCapture } from "./test-runtime-capture.js";

const runtimeState = vi.hoisted(() => ({ capture: null as CliRuntimeCapture | null }));

function getRuntimeCapture(): CliRuntimeCapture {
  if (!runtimeState.capture) {
    throw new Error("runtime capture not initialized");
  }
  return runtimeState.capture;
}

function getRuntime() {
  return getRuntimeCapture().defaultRuntime;
}

const mocks = vi.hoisted(() => {
  return {
    callBrowserRequest: vi.fn<
      (
        opts: unknown,
        req: { path?: string },
        runtimeOpts?: { timeoutMs?: number },
      ) => Promise<Record<string, unknown>>
    >(async () => ({})),
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

vi.mock("../runtime.js", async () => {
  const { createCliRuntimeCapture } = await import("./test-runtime-capture.js");
  runtimeState.capture ??= createCliRuntimeCapture();
  return { defaultRuntime: runtimeState.capture.defaultRuntime };
});

function createProgram() {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserManageCommands(browser, parentOpts);
  return program;
}

describe("browser manage output", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getRuntimeCapture().resetRuntimeCapture();
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

    const output = getRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows configured userDataDir for existing-session status", async () => {
    mocks.callBrowserRequest.mockImplementation(async (_opts: unknown, req: { path?: string }) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "brave-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
            color: "#FB542B",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createProgram();
    await program.parseAsync(["browser", "--browser-profile", "brave-live", "status"], {
      from: "user",
    });

    const output = getRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain(
      "userDataDir: /Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    );
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

    const output = getRuntime().log.mock.calls.at(-1)?.[0] as string;
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
            userDataDir: null,
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

    const output = getRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts sensitive remote cdpUrl details in status output", async () => {
    mocks.callBrowserRequest.mockImplementation(async (_opts: unknown, req: { path?: string }) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "remote",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: null,
            cdpPort: 9222,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
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
    await program.parseAsync(["browser", "--browser-profile", "remote", "status"], {
      from: "user",
    });

    const output = getRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });
});
