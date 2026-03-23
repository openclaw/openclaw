import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn((value: string) => {
      mocks.runtime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      mocks.runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
    writeStdout: vi.fn((value: string) => mocks.runtime.log(value)),
    writeJson: vi.fn((value: unknown, space = 2) =>
      mocks.runtime.log(JSON.stringify(value, null, space)),
    ),
  },
  loadConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
  qrGenerate: vi.fn((_input: unknown, _opts: unknown, cb: (output: string) => void) => {
    cb("ASCII-QR");
  }),
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));
vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));
vi.mock("qrcode-terminal", () => ({
  default: {
    generate: mocks.qrGenerate,
  },
}));

const runtime = mocks.runtime;
const loadConfig = mocks.loadConfig;
const runCommandWithTimeout = mocks.runCommandWithTimeout;
const resolveCommandSecretRefsViaGateway = mocks.resolveCommandSecretRefsViaGateway;
const qrGenerate = mocks.qrGenerate;

const { registerQrCli } = await import("./qr-cli.js");

function createRemoteQrConfig(params?: { withTailscale?: boolean }) {
  return {
    gateway: {
      ...(params?.withTailscale ? { tailscale: { mode: "serve" } } : {}),
      remote: { url: "wss://remote.example.com:444", token: "remote-tok" },
      auth: { mode: "token", token: "local-tok" },
    },
    plugins: {
      entries: {
        "device-pair": {
          config: {
            publicUrl: "wss://wrong.example.com:443",
          },
        },
      },
    },
  };
}

function createTailscaleRemoteRefConfig() {
  return {
    gateway: {
      tailscale: { mode: "serve" },
      remote: {
        token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
      },
      auth: {},
    },
  };
}

function createDefaultSecretProvider() {
  return {
    providers: {
      default: { source: "env" as const },
    },
  };
}

function createLocalGatewayConfigWithAuth(auth: Record<string, unknown>) {
  return {
    secrets: createDefaultSecretProvider(),
    gateway: {
      bind: "custom",
      customBindHost: "gateway.local",
      auth,
    },
  };
}

function createLocalGatewayPasswordRefAuth(secretId: string) {
  return {
    mode: "password",
    password: { source: "env", provider: "default", id: secretId },
  };
}

function createLocalGatewayEnvPasswordRefAuth(secretId: string) {
  return {
    password: { source: "env", provider: "default", id: secretId },
  };
}

describe("registerQrCli", () => {
  function createProgram() {
    const program = new Command();
    registerQrCli(program);
    return program;
  }

  async function runQr(args: string[]) {
    const program = createProgram();
    await program.parseAsync(["qr", ...args], { from: "user" });
  }

  async function expectQrExit(args: string[]) {
    await expect(runQr(args)).rejects.toThrow("exit");
  }

  function parseLastLoggedQrJson() {
    return JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0] ?? "{}")) as {
      setupCode?: string;
      gatewayUrl?: string;
      auth?: string;
      urlSource?: string;
    };
  }

  function expectLoggedSetupCode(url: string) {
    const expected = encodePairingSetupCode({
      url,
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  }

  function expectLoggedLocalSetupCode() {
    expectLoggedSetupCode("ws://gateway.local:18789");
  }

  function mockTailscaleStatusLookup() {
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"ts-host.tailnet.ts.net."}}',
      stderr: "",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_PASSWORD", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints setup code only when requested", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr(["--setup-code-only"]);

    const expected = encodePairingSetupCode({
      url: "ws://gateway.local:18789",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
    expect(qrGenerate).not.toHaveBeenCalled();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("renders ASCII QR by default", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr([]);

    expect(qrGenerate).toHaveBeenCalledTimes(1);
    const output = runtime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Pairing QR");
    expect(output).toContain("ASCII-QR");
    expect(output).toContain("Gateway:");
    expect(output).toContain("openclaw devices approve <requestId>");
  });

  it("accepts --token override when config has no auth", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
      },
    });

    await runQr(["--setup-code-only", "--token", "override-token"]);

    expectLoggedLocalSetupCode();
  });

  it("skips local password SecretRef resolution when --token override is provided", async () => {
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only", "--token", "override-token"]);

    expectLoggedLocalSetupCode();
  });

  it("resolves local gateway auth password SecretRefs before setup code generation", async () => {
    vi.stubEnv("QR_LOCAL_GATEWAY_PASSWORD", "local-password-secret");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("QR_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving local password SecretRef", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "password-from-env");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("does not resolve local password SecretRef when auth mode is token", async () => {
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth({
        mode: "token",
        token: "token-123",
        ...createLocalGatewayEnvPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      }),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("resolves local password SecretRef when auth mode is inferred", async () => {
    vi.stubEnv("QR_INFERRED_GATEWAY_PASSWORD", "inferred-password");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth({
        ...createLocalGatewayEnvPasswordRefAuth("QR_INFERRED_GATEWAY_PASSWORD"),
      }),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("fails when token and password SecretRefs are both configured with inferred mode", async () => {
    vi.stubEnv("QR_INFERRED_GATEWAY_TOKEN", "inferred-token");
    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: {
          token: { source: "env", provider: "default", id: "QR_INFERRED_GATEWAY_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_GATEWAY_PASSWORD" },
        },
      },
    });

    await expectQrExit(["--setup-code-only"]);
    const output = runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("gateway.auth.mode is unset");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("exits with error when gateway config is not pairable", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit([]);

    const output = runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("only bound to loopback");
  });

  it("uses gateway.remote.url when --remote is set (ignores device-pair publicUrl)", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    await runQr(["--setup-code-only", "--remote"]);

    const expected = encodePairingSetupCode({
      url: "wss://remote.example.com:444",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "qr --remote",
        targetIds: new Set(["gateway.remote.token", "gateway.remote.password"]),
      }),
    );
  });

  it("logs remote secret diagnostics in non-json output mode", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.token inactive"] as string[],
    });

    await runQr(["--remote"]);

    expect(
      runtime.log.mock.calls.some((call) =>
        String(call[0] ?? "").includes("gateway.remote.token inactive"),
      ),
    ).toBe(true);
  });

  it("routes remote secret diagnostics to stderr for setup-code-only output", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.token inactive"] as string[],
    });

    await runQr(["--setup-code-only", "--remote"]);

    expect(
      runtime.error.mock.calls.some((call) =>
        String(call[0] ?? "").includes("gateway.remote.token inactive"),
      ),
    ).toBe(true);
    const expected = encodePairingSetupCode({
      url: "wss://remote.example.com:444",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });

  it.each([
    { name: "without tailscale configured", withTailscale: false },
    { name: "when tailscale is configured", withTailscale: true },
  ])("reports gateway.remote.url as source in --remote json output ($name)", async (testCase) => {
    loadConfig.mockReturnValue(createRemoteQrConfig({ withTailscale: testCase.withTailscale }));
    mockTailscaleStatusLookup();

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload.gatewayUrl).toBe("wss://remote.example.com:444");
    expect(payload.auth).toBe("token");
    expect(payload.urlSource).toBe("gateway.remote.url");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("routes remote secret diagnostics to stderr for json output", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.password inactive"] as string[],
    });
    mockTailscaleStatusLookup();

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload.gatewayUrl).toBe("wss://remote.example.com:444");
    expect(
      runtime.error.mock.calls.some((call) =>
        String(call[0] ?? "").includes("gateway.remote.password inactive"),
      ),
    ).toBe(true);
  });

  it("errors when --remote is set but no remote URL is configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit(["--remote"]);
    const output = runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("qr --remote requires");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("supports --remote with tailscale serve when remote token ref resolves", async () => {
    loadConfig.mockReturnValue(createTailscaleRemoteRefConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {
        gateway: {
          tailscale: { mode: "serve" },
          remote: {
            token: "tailscale-remote-token",
          },
          auth: {},
        },
      },
      diagnostics: [],
    });
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"ts-host.tailnet.ts.net."}}',
      stderr: "",
    });

    await runQr(["--json", "--remote"]);

    const payload = JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0] ?? "{}")) as {
      gatewayUrl?: string;
      auth?: string;
      urlSource?: string;
    };
    expect(payload.gatewayUrl).toBe("wss://ts-host.tailnet.ts.net");
    expect(payload.auth).toBe("token");
    expect(payload.urlSource).toBe("gateway.tailscale.mode=serve");
  });
});
