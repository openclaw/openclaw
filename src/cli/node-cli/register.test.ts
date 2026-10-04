import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../../pairing/setup-code.js";
import { registerNodeCli } from "./register.js";

const PAIR_TLS_FINGERPRINT = "ab".repeat(32);
const EXPLICIT_TLS_FINGERPRINT = "cd".repeat(32);
const SAVED_TLS_FINGERPRINT = "ef".repeat(32);

type LoadNodeHostConfig = typeof import("../../node-host/config.js").loadNodeHostConfig;

const daemonMocks = vi.hoisted(() => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
  loadNodeHostConfig: vi.fn<LoadNodeHostConfig>(async () => null),
  runNodeHost: vi.fn(),
  runNodeHostWorker: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonRestart: vi.fn(),
  runNodeDaemonStart: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
  runNodeDaemonStop: vi.fn(),
  runNodeDaemonUninstall: vi.fn(),
}));

vi.mock("./daemon.js", () => daemonMocks);

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: daemonMocks.loadNodeHostConfig,
}));

vi.mock("../../node-host/runner.js", () => ({
  runNodeHost: daemonMocks.runNodeHost,
}));

vi.mock("../../node-host/worker.js", () => ({
  runNodeHostWorker: daemonMocks.runNodeHostWorker,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: daemonMocks.defaultRuntime,
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerNodeCli(program);
  return program;
}

const run = (args: string[]) => createProgram().parseAsync(["node", ...args], { from: "user" });
const expectHost = (expected: Record<string, unknown>) =>
  expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(expect.objectContaining(expected));
const savedGateway = {
  host: "10.0.0.2",
  port: 19001,
  tls: true,
  tlsFingerprint: SAVED_TLS_FINGERPRINT,
  contextPath: "/saved",
};
const pairCode = (overrides: Partial<Parameters<typeof encodePairingSetupCode>[0]> = {}) =>
  encodePairingSetupCode({
    url: "wss://gateway.example:8443/openclaw-gw",
    bootstrapToken: "bootstrap-123",
    tlsFingerprint: `sha256:${PAIR_TLS_FINGERPRINT.toUpperCase()}`,
    ...overrides,
  });

describe("registerNodeCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonMocks.loadNodeHostConfig.mockResolvedValue(null);
  });

  it("forwards the private worker's explicit desktop preference", async () => {
    await run(["worker", "--desktop-sharing"]);
    expect(daemonMocks.runNodeHostWorker).toHaveBeenCalledWith({ desktopSharingEnabled: true });
  });

  it("forwards hidden companion preferences, scoped authentication and parent lifetime", async () => {
    const program = await run(["run", "--no-desktop-sharing", "--auth-from-env", "--parent-stdin"]);
    expectHost({ desktopSharingEnabled: false, gatewayAuthFromEnv: true, parentStdin: true });
    const help = program.commands
      .find((command) => command.name() === "node")
      ?.commands.find((command) => command.name() === "run")
      ?.helpInformation();
    for (const flag of ["--desktop-sharing", "--auth-from-env", "--parent-stdin"]) {
      expect(help).not.toContain(flag);
    }
  });

  it.each([
    ["status", daemonMocks.runNodeDaemonStatus],
    ["uninstall", daemonMocks.runNodeDaemonUninstall],
    ["stop", daemonMocks.runNodeDaemonStop],
    ["start", daemonMocks.runNodeDaemonStart],
    ["restart", daemonMocks.runNodeDaemonRestart],
  ])("registers node %s and forwards --json", async (command, action) => {
    await run([command, "--json"]);
    expect(action.mock.calls[0]?.[0]?.json).toBe(true);
  });

  it("forwards install options and an exact runtime pin", async () => {
    const pin = "C:\\Runtime Tools\\node.exe";
    await run([
      "install",
      "--port",
      "19000",
      "--host",
      "gateway.example",
      "--runtime",
      "bun",
      "--runtime-path",
      pin,
      "--force",
      "--json",
    ]);
    expect(daemonMocks.runNodeDaemonInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        port: "19000",
        host: "gateway.example",
        runtime: "bun",
        runtimePath: pin,
        force: true,
        json: true,
      }),
    );
  });

  it.each(["run", "install"] as const)(
    "accepts exact command allowlists before or after node %s",
    async (leaf) => {
      const action = leaf === "run" ? daemonMocks.runNodeHost : daemonMocks.runNodeDaemonInstall;
      for (const args of [
        ["--commands", "fixture.read,fixture.list", leaf],
        [leaf, "--commands", "fixture.read", "--commands", "fixture.list,fixture.read"],
      ]) {
        await run(args);
        expect(action).toHaveBeenLastCalledWith(
          expect.objectContaining({ commands: ["fixture.list", "fixture.read"] }),
        );
      }
    },
  );

  it("rejects empty command ids instead of silently widening the surface", async () => {
    await expect(run(["run", "--commands", "fixture.list,"])).rejects.toThrow(
      "non-empty command ids",
    );
    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
  });

  it.each(["run", "install"] as const)(
    "accepts --all-commands before or after node %s",
    async (leaf) => {
      const action = leaf === "run" ? daemonMocks.runNodeHost : daemonMocks.runNodeDaemonInstall;
      for (const args of [
        ["--all-commands", leaf],
        [leaf, "--all-commands"],
      ]) {
        await run(args);
        expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ allCommands: true }));
      }
    },
  );

  it.each(["run", "install"] as const)(
    "rejects conflicting command selections for node %s",
    async (leaf) => {
      for (const args of [
        [leaf, "--all-commands", "--commands", "fixture.read"],
        ["--all-commands", leaf, "--commands", "fixture.read"],
        ["--commands", "fixture.read", leaf, "--all-commands"],
        ["--commands", "fixture.read", "--all-commands", leaf],
      ]) {
        await expect(run(args)).rejects.toThrow(/--all-commands.*--commands/);
      }
      expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
      expect(daemonMocks.runNodeDaemonInstall).not.toHaveBeenCalled();
      expect(daemonMocks.loadNodeHostConfig).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "--ephemeral", "--session-host"])(
    "hosts worker turns only on request: %s",
    async (flag) => {
      const program = await run(["run", ...(flag ? [flag] : [])]);
      if (flag) {
        expectHost({
          forceWorkerRuns: true,
          ...(flag === "--ephemeral" ? { ephemeral: true } : {}),
        });
      } else {
        expect(daemonMocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
      }
      if (flag !== "--ephemeral") {
        expect(daemonMocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("ephemeral");
      }
      expect(
        program.commands
          .find((command) => command.name() === "node")
          ?.commands.find((command) => command.name() === "run")
          ?.helpInformation(),
      ).not.toContain("--ephemeral");
      expect(daemonMocks.runNodeDaemonInstall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["--pair", true],
    ["--pair-if-needed", false],
  ] as const)(
    "derives endpoint and authentication preference from %s",
    async (flag, preferBootstrap) => {
      await run(["run", flag, `oc-pair://${pairCode()}`]);
      expectHost({
        gatewayHost: "gateway.example",
        gatewayPort: 8443,
        gatewayContextPath: "/openclaw-gw",
        gatewayTls: true,
        gatewayTlsFingerprint: PAIR_TLS_FINGERPRINT,
        gatewayCandidates: [
          {
            host: "gateway.example",
            port: 8443,
            contextPath: "/openclaw-gw",
            tls: true,
            tlsFingerprint: PAIR_TLS_FINGERPRINT,
          },
        ],
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: preferBootstrap,
      });
    },
  );

  it.each(["--pair", "--pair-if-needed"])(
    "handles expired pairing according to %s",
    async (flag) => {
      await run([
        "run",
        flag,
        pairCode({
          url: "wss://paired.example/node",
          bootstrapToken: "expired-test-bootstrap",
          expiresAtMs: 1,
          tlsFingerprint: undefined,
        }),
      ]);
      if (flag === "--pair") {
        expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
          "Pairing setup code has expired.",
        );
        expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
      } else {
        expect(daemonMocks.defaultRuntime.error).not.toHaveBeenCalled();
        expectHost({
          gatewayHost: "paired.example",
          gatewayBootstrapToken: "expired-test-bootstrap",
          gatewayBootstrapExpiresAtMs: 1,
          preferGatewayBootstrapToken: false,
        });
      }
    },
  );

  it.each([
    { urls: ["wss://paired.example/node", 42] },
    { tlsFingerprint: "invalid-pin" },
    { expiresAtMs: -1 },
  ])("rejects malformed fallback payload fields: %j", async (invalidFields) => {
    const code = Buffer.from(
      JSON.stringify({
        url: "wss://paired.example/node",
        bootstrapToken: "expired-test-bootstrap",
        expiresAtMs: 1,
        ...invalidFields,
      }),
    ).toString("base64url");
    await run(["run", "--pair-if-needed", code]);
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith("Invalid pairing setup payload.");
    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
  });

  it("rejects simultaneous forced and resumable pairing", async () => {
    await expect(
      run(["run", "--pair", "first", "--pair-if-needed", "second"]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.loadNodeHostConfig).not.toHaveBeenCalled();
  });

  it("lets explicit gateway flags override --pair values", async () => {
    await run([
      "run",
      "--pair",
      pairCode({ url: "wss://paired.example:8443" }),
      "--host",
      "explicit.example",
      "--port",
      "19000",
      "--tls-fingerprint",
      `sha256:${EXPLICIT_TLS_FINGERPRINT}`,
    ]);
    expectHost({
      gatewayHost: "explicit.example",
      gatewayPort: 19000,
      gatewayTls: true,
      gatewayTlsFingerprint: EXPLICIT_TLS_FINGERPRINT,
      gatewayCandidates: undefined,
      gatewayBootstrapToken: "bootstrap-123",
    });
  });

  it.each([
    { args: ["--port", "abc"], error: "Invalid --port" },
    { args: ["--pair", "not-a-setup-code"], error: "Invalid pairing setup" },
    {
      args: ["--no-tls", "--tls-fingerprint", PAIR_TLS_FINGERPRINT],
      error: "--no-tls cannot be combined with --tls-fingerprint",
    },
    { args: ["--tls-fingerprint", "sha256:abc123"], error: "Invalid TLS fingerprint" },
  ])("rejects invalid connection flags $args before starting the host", async ({ args, error }) => {
    await run(["run", ...args]);
    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
      args[0] === "--no-tls" ? error : expect.stringContaining(error),
    );
    expect(daemonMocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    if (args[0] === "--pair") {
      expect(daemonMocks.loadNodeHostConfig).not.toHaveBeenCalled();
    }
  });

  it.each([
    { args: [], changed: false, plaintext: false },
    { args: ["--host", "10.0.0.2"], changed: false, plaintext: false },
    { args: ["--port", "19001"], changed: false, plaintext: false },
    { args: ["--host", "10.0.0.3"], changed: true, plaintext: false },
    { args: ["--port", "19002"], changed: true, plaintext: false },
    { args: ["--no-tls"], changed: false, plaintext: true },
  ])(
    "inherits saved TLS only for the saved endpoint: $args",
    async ({ args, changed, plaintext }) => {
      daemonMocks.loadNodeHostConfig.mockResolvedValue({
        version: 1,
        nodeId: "node-existing",
        gateway: savedGateway,
      });
      await run(["run", ...args]);
      expectHost({
        gatewayTls: plaintext ? false : changed ? undefined : true,
        gatewayTlsFingerprint: changed || plaintext ? undefined : SAVED_TLS_FINGERPRINT,
        gatewayContextPath: changed ? undefined : "/saved",
        ...(!changed ? { gatewayHost: "10.0.0.2", gatewayPort: 19001 } : {}),
        ...(args[1] === "10.0.0.3" ? { gatewayHost: "10.0.0.3" } : {}),
      });
    },
  );
});
