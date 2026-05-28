import { afterEach, describe, expect, it, vi } from "vitest";
import { configHandlers, resolveConfigOpenCommand } from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: Object.assign(execFileMock, {
        __promisify__: vi.fn(),
      }) as typeof import("node:child_process").execFile,
    },
  );
});

function invokeExecFileCallback(args: unknown[], error: Error | null) {
  const callback = args.at(-1);
  expect(callback).toEqual(expect.any(Function));
  (callback as (error: Error | null) => void)(error);
}

describe("resolveConfigOpenCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses xdg-open on Linux", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses a quoted PowerShell literal on Windows", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -LiteralPath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("config.openFile", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    vi.clearAllMocks();
  });

  it("opens the configured file without shell interpolation", async () => {
    const configPath =
      process.platform === "win32"
        ? String.raw`D:\tmp\config $(touch pwned).json`
        : "/tmp/config $(touch pwned).json";
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    const expectedCommand = resolveConfigOpenCommand(configPath);
    execFileMock.mockImplementation((...args: unknown[]) => {
      expect(args[0]).toBe(expectedCommand.command);
      expect(args[1]).toEqual(expectedCommand.args);
      invokeExecFileCallback(args, null);
      return {} as never;
    });

    const { options, respond } = createConfigHandlerHarness({ method: "config.openFile" });
    await configHandlers["config.openFile"](options);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        path: configPath,
      },
      undefined,
    );
  });

  it("returns a generic error and logs details when the opener fails", async () => {
    const configPath =
      process.platform === "win32" ? String.raw`D:\tmp\config.json` : "/tmp/config.json";
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    execFileMock.mockImplementation((...args: unknown[]) => {
      invokeExecFileCallback(
        args,
        Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
      );
      return {} as never;
    });

    const { options, respond, logGateway } = createConfigHandlerHarness({
      method: "config.openFile",
    });
    await configHandlers["config.openFile"](options);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: false,
        path: configPath,
        error: "failed to open config file",
      },
      undefined,
    );
    expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("spawn xdg-open ENOENT"));
  });
});
