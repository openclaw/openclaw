import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
const runGatewayLoop = vi.fn(async ({ start }: { start: () => Promise<unknown> }) => {
  await start();
});
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { exists: false } as Record<string, unknown>,
}));
const resolveStateDir = vi.fn<(env?: NodeJS.ProcessEnv) => string>(() => "/tmp");
const resolveConfigPath = vi.fn((_env: NodeJS.ProcessEnv, stateDir: string) => {
  return `${stateDir}/openclaw.json`;
});

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  loadConfig: () => configState.cfg,
  readConfigFileSnapshot: async () => configState.snapshot,
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveStateDir: (env?: NodeJS.ProcessEnv) => resolveStateDir(env),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: {
    authConfig?: { mode?: string; token?: unknown; password?: unknown };
    authOverride?: { mode?: string; token?: unknown; password?: unknown };
    env?: NodeJS.ProcessEnv;
  }) => {
    const mode = params.authOverride?.mode ?? params.authConfig?.mode ?? "token";
    const token =
      (typeof params.authOverride?.token === "string" ? params.authOverride.token : undefined) ??
      (typeof params.authConfig?.token === "string" ? params.authConfig.token : undefined) ??
      params.env?.OPENCLAW_GATEWAY_TOKEN;
    const password =
      (typeof params.authOverride?.password === "string"
        ? params.authOverride.password
        : undefined) ??
      (typeof params.authConfig?.password === "string" ? params.authConfig.password : undefined) ??
      params.env?.OPENCLAW_GATEWAY_PASSWORD;
    return {
      mode,
      token,
      password,
      allowTailscale: false,
    };
  },
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  GatewayLockError: class GatewayLockError extends Error {},
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: () => undefined,
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
  waitForPortBindable: (port: number, opts?: unknown) => waitForPortBindable(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: () => Promise<unknown> }) => runGatewayLoop(params),
}));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run.js").addGatewayRunCommand;
  let sharedProgram: Command;

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    const gateway = addGatewayRunCommand(sharedProgram.command("gateway"));
    addGatewayRunCommand(gateway.command("run"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { exists: false };
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    forceFreePortAndWait.mockClear();
    waitForPortBindable.mockClear();
    ensureDevGatewayConfig.mockClear();
    runGatewayLoop.mockClear();
    resolveStateDir.mockReset();
    resolveStateDir.mockReturnValue("/tmp");
    resolveConfigPath.mockReset();
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  function expectAuthOverrideMode(mode: string) {
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode,
        }),
      }),
    );
  }

  async function expectGatewayExit(argv: string[]) {
    await expect(runGatewayCli(argv)).rejects.toThrow("__exit__:1");
  }

  async function withTempPasswordFile<T>(
    password: string,
    run: (params: { passwordFile: string }) => Promise<T>,
  ): Promise<T> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-run-"));
    const passwordFile = path.join(dir, "password.txt");
    try {
      await fsPromises.writeFile(passwordFile, password, "utf8");
      return await run({ passwordFile });
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  }

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(forceFreePortAndWait).toHaveBeenCalledWith(18789, expect.anything());
    expect(waitForPortBindable).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({ host: "127.0.0.1" }),
    );
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "tok_run",
        }),
      }),
    );
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it.each(["none", "trusted-proxy"] as const)("accepts --auth %s override", async (mode) => {
    await runGatewayCli(["gateway", "run", "--auth", mode, "--allow-unconfigured"]);

    expectAuthOverrideMode(mode);
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth (use "none", "token", "password", or "trusted-proxy")',
    );
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = { exists: true, parsed: configState.cfg };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it("reads gateway password from --password-file", async () => {
    await withTempPasswordFile("pw_from_file\n", async ({ passwordFile }) => {
      await runGatewayCli([
        "gateway",
        "run",
        "--auth",
        "password",
        "--password-file",
        passwordFile ?? "",
        "--allow-unconfigured",
      ]);
    });

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode: "password",
          password: "pw_from_file", // pragma: allowlist secret
        }),
      }),
    );
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempPasswordFile("pw_from_file\n", async ({ passwordFile }) => {
      await expect(
        runGatewayCli([
          "gateway",
          "run",
          "--password",
          "pw_inline",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]),
      ).rejects.toThrow("__exit__:1");
    });

    expect(runtimeErrors).toContain("Use either --password or --password-file.");
  });

  it("hard-stops --dev --reset when target resolves to default profile paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw");
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });

    await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
    expect(runtimeErrors.join("\n")).toContain("/Users/test/.openclaw");
  });

  it("allows --dev --reset when target resolves to dev profile paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw-dev");
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });

    await runGatewayCli(["gateway", "run", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("allows --dev --reset for explicit non-default custom state/config paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/custom-dev");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/custom-dev/openclaw.json");
    resolveStateDir.mockReturnValue("/tmp/custom-dev");
    resolveConfigPath.mockReturnValue("/tmp/custom-dev/openclaw.json");

    await runGatewayCli(["gateway", "run", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("allows --dev --reset for explicit non-default legacy state/config paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("CLAWDBOT_STATE_DIR", "/tmp/custom-dev");
    vi.stubEnv("CLAWDBOT_CONFIG_PATH", "/tmp/custom-dev/openclaw.json");
    resolveStateDir.mockReturnValue("/tmp/custom-dev");
    resolveConfigPath.mockReturnValue("/tmp/custom-dev/openclaw.json");

    await runGatewayCli(["gateway", "run", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("hard-stops --dev --reset when state/config match non-dev profile defaults", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/test/.openclaw-work");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/Users/test/.openclaw-work/openclaw.json");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw-work");
    resolveConfigPath.mockReturnValue("/Users/test/.openclaw-work/openclaw.json");

    await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
  });

  it("hard-stops --dev --reset when legacy env resolves to non-dev profile defaults", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("CLAWDBOT_STATE_DIR", "/Users/test/.openclaw-work");
    vi.stubEnv("CLAWDBOT_CONFIG_PATH", "/Users/test/.openclaw-work/openclaw.json");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw-work");
    resolveConfigPath.mockReturnValue("/Users/test/.openclaw-work/openclaw.json");

    await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
  });

  it("hard-stops --dev --reset when state is profile-default but config is custom", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/test/.openclaw-work");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/custom-dev/openclaw.json");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw-work");
    resolveConfigPath.mockReturnValue("/tmp/custom-dev/openclaw.json");

    await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
  });

  it("treats symlinked default paths as default reset targets", async () => {
    const home = "/Users/test";
    const defaultStateDir = path.join(home, ".openclaw");
    const defaultConfigPath = path.join(defaultStateDir, "openclaw.json");
    const aliasStateDir = path.join(home, ".openclaw-alias");
    const aliasConfigPath = path.join(aliasStateDir, "openclaw.json");
    const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((candidate) => {
      const resolved = path.resolve(String(candidate));
      if (resolved === path.resolve(aliasStateDir)) {
        return path.resolve(defaultStateDir);
      }
      if (resolved === path.resolve(aliasConfigPath)) {
        return path.resolve(defaultConfigPath);
      }
      return resolved;
    });

    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", aliasStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", aliasConfigPath);
    resolveStateDir.mockReturnValue(aliasStateDir);
    resolveConfigPath.mockReturnValue(aliasConfigPath);

    try {
      await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);
    } finally {
      realpathSpy.mockRestore();
    }

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
  });
});
