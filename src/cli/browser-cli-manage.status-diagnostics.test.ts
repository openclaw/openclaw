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
            profile: "remote",
            running: false,
            cdpPort: 9222,
            cdpUrl: "http://10.0.0.42:9222",
            chosenBrowser: null,
            detectedBrowser: "chrome",
            detectedExecutablePath: "/tmp/chrome",
            userDataDir: null,
            color: "#0066CC",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
            diagnostics: [
              {
                code: "ATTACH_ONLY_PROFILE",
                layer: "profile",
                level: "info",
                summary:
                  "Attach-only profile: OpenClaw will connect to an existing browser instead of launching one.",
                hint: "Expected CDP endpoint: http://10.0.0.42:9222/json/version",
              },
              {
                code: "REMOTE_CDP_HTTP_UNREACHABLE",
                layer: "cdp",
                level: "danger",
                summary: "Remote CDP HTTP unreachable at http://10.0.0.42:9222/json/version.",
                hint: "Check port forwarding, Windows firewall, and the browser bind address.",
              },
            ],
          }
        : {},
    ),
    callGatewayConfigSnapshot: vi.fn(async () => ({
      resolved: {
        gateway: {
          bind: "lan",
          port: 18789,
          auth: { mode: "token", token: "[REDACTED]" },
          controlUi: {
            enabled: true,
            allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
          },
        },
      },
    })),
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
  callGatewayConfigSnapshot: mocks.callGatewayConfigSnapshot,
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

describe("browser status diagnostics output", () => {
  function createProgram() {
    const { program, browser, parentOpts } = createBrowserProgram();
    registerBrowserManageCommands(browser, parentOpts);
    return program;
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.callGatewayConfigSnapshot.mockClear();
    mocks.runtimeLog.mockClear();
    mocks.runtimeError.mockClear();
    mocks.runtimeExit.mockClear();
  });

  it("prints layered diagnostics under browser status", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(mocks.runtimeLog).toHaveBeenCalledTimes(1);
    const output = String(mocks.runtimeLog.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("diagnostics:");
    expect(output).toContain("[control-ui/info] Control UI origin allowlist is configured");
    expect(output).toContain("[control-ui/info] Gateway Control UI requires a gateway token");
    expect(output).toContain("[profile/info] Attach-only profile");
    expect(output).toContain("[cdp/danger] Remote CDP HTTP unreachable");
    expect(output).toContain("Windows firewall");
  });
});
