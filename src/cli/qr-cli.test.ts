import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { createCliRuntimeCapture, mockRuntimeModule } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
  renderTerminal: vi.fn(async () => "ASCII-QR"),
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));
const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
const runtimeLog = runtime.log;
const runtimeError = runtime.error;
const runtimeExit = runtime.exit;

vi.doMock("../runtime.js", async () => {
  return mockRuntimeModule(
    () => vi.importActual<typeof import("../runtime.js")>("../runtime.js"),
    runtime,
  );
});
// mock-isolation: QR setup resolves fixture config and secrets without host credentials.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.loadConfig>) =>
    async () =>
      mocks.loadConfig(...args),
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("../media/qr-terminal.ts", () => ({
  renderQrTerminal: mocks.renderTerminal,
}));
vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: mocks.issueDevicePairSetupBootstrapToken,
}));
const loadConfig = mocks.loadConfig;
const runCommandWithTimeout = mocks.runCommandWithTimeout;
const resolveCommandSecretRefsViaGateway = mocks.resolveCommandSecretRefsViaGateway;
const issueDevicePairSetupBootstrapToken = mocks.issueDevicePairSetupBootstrapToken;

const { registerQrCli } = await import("./qr-cli.js");

function createTokenGatewayConfig(customBindHost = "127.0.0.1") {
  return {
    gateway: {
      bind: "custom",
      customBindHost,
      auth: { mode: "token", token: "tok" },
    },
  };
}

function createRemoteQrConfig() {
  return {
    gateway: {
      publicOrigin: "https://gateway.example.test",
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

function setLocalAuth(auth: Record<string, unknown>, customBindHost = "127.0.0.1") {
  loadConfig.mockReturnValue({
    secrets: { providers: { default: { source: "env" } } },
    gateway: {
      bind: "custom",
      customBindHost,
      auth,
    },
  });
}

const secretRef = (id: string) => ({ source: "env", provider: "default", id });
const missingPassword = secretRef("MISSING_LOCAL_GATEWAY_PASSWORD");

describe("registerQrCli", () => {
  async function runQr(args: string[]) {
    const program = new Command();
    registerQrCli(program);
    await program.parseAsync(["qr", ...args], { from: "user" });
  }

  async function expectQrExit(args: string[]) {
    await expect(runQr(args)).rejects.toThrow("exit");
  }

  function readRuntimeCallText(call: unknown[] | undefined): string {
    const value = call?.[0];
    if (typeof value === "string") {
      return value;
    }
    return value === undefined ? "" : JSON.stringify(value);
  }

  const errorText = () => runtimeError.mock.calls.map(readRuntimeCallText).join("\n");

  function parseLastLoggedQrJson() {
    const calls = runtimeLog.mock.calls;
    const raw = calls[calls.length - 1]?.[0];
    return JSON.parse(typeof raw === "string" ? raw : "{}") as {
      setupCode?: string;
      gatewayUrl?: string;
      auth?: string;
      urlSource?: string;
      access?: "full" | "limited";
      accessDowngraded?: boolean;
    };
  }

  function expectLoggedSetupCode(url: string) {
    const expected = encodePairingSetupCode({
      url,
      bootstrapToken: "bootstrap-123",
      expiresAtMs: 123,
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
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
    resetRuntimeCapture();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    runtimeExit.mockImplementation(() => {
      throw new Error("exit");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { args: [], profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE, access: "full" },
    {
      args: ["--voice-node"],
      profile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      access: "limited",
    },
  ])(
    "issues trusted-proxy QR output with the existing $args grant",
    async ({ args, profile, access }) => {
      setLocalAuth({ mode: "trusted-proxy" });

      await runQr(["--json", "--url", "wss://gateway.example.test", ...args]);

      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          auth: "trusted-proxy",
          gatewayUrl: "wss://gateway.example.test",
          access,
        }),
      );
      expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ profile }),
      );
      expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    },
  );

  it("uses the bounded bootstrap profile with --limited", async () => {
    loadConfig.mockReturnValue(createTokenGatewayConfig());

    await runQr(["--setup-code-only", "--limited"]);

    expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: {
          roles: ["node", "operator"],
          scopes: [
            "operator.approvals",
            "operator.questions",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
        },
      }),
    );
  });

  const conflictingQrOptions = [
    {
      name: "access profiles",
      args: ["--limited", "--voice-node"],
      message: "Use either --limited or --voice-node, not both.",
    },
    {
      name: "authentication overrides",
      args: ["--token", "test-token", "--password", "test-password"],
      message: "Use either --token or --password, not both.",
    },
  ];

  it.each(conflictingQrOptions)("rejects conflicting $name in human mode", async (testCase) => {
    await expect(runQr(["--setup-code-only", ...testCase.args])).rejects.toThrow("exit");

    expect(runtimeError).toHaveBeenCalledExactlyOnceWith(testCase.message);
    expect(runtimeExit).toHaveBeenCalledExactlyOnceWith(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("fails fast for insecure remote mobile pairing setup urls", async () => {
    loadConfig.mockReturnValue(createTokenGatewayConfig("gateway.example"));

    await expectQrExit(["--setup-code-only"]);

    const output = errorText();
    expect(output).toContain("Tailscale and public mobile pairing require a secure gateway URL");
    expect(output).toContain("gateway.tailscale.mode=serve");
  });

  it("allows private LAN IP cleartext setup urls", async () => {
    loadConfig.mockReturnValue(createTokenGatewayConfig("192.168.1.8"));

    await runQr(["--setup-code-only"]);

    expectLoggedSetupCode("ws://192.168.1.8:18789");
    expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledWith(
      expect.objectContaining({ profile: PAIRING_SETUP_BOOTSTRAP_PROFILE }),
    );
    expect(errorText()).toContain("setup code was limited for safety");
    expect(errorText()).toContain("Use wss:// or Tailscale Serve");
  });

  it("skips local password SecretRef resolution when --token override is provided", async () => {
    setLocalAuth({ mode: "password", password: missingPassword });

    await runQr(["--setup-code-only", "--token", "override-token"]);

    expectLoggedSetupCode("ws://127.0.0.1:18789");
  });

  it("resolves local gateway auth password SecretRefs before setup code generation", async () => {
    vi.stubEnv("QR_LOCAL_GATEWAY_PASSWORD", "local-password-secret");
    setLocalAuth({ mode: "password", password: secretRef("QR_LOCAL_GATEWAY_PASSWORD") });

    await runQr(["--setup-code-only"]);

    expectLoggedSetupCode("ws://127.0.0.1:18789");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("does not let OPENCLAW_GATEWAY_PASSWORD mask a local password SecretRef", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "password-from-env");
    setLocalAuth({ mode: "password", password: missingPassword });

    await expectQrExit(["--setup-code-only"]);
    expect(errorText()).toContain("MISSING_LOCAL_GATEWAY_PASSWORD");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("does not resolve local password SecretRef when auth mode is token", async () => {
    setLocalAuth({ mode: "token", token: "token-123", password: missingPassword });

    await runQr(["--setup-code-only"]);

    expectLoggedSetupCode("ws://127.0.0.1:18789");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("fails when token and password SecretRefs are both configured with inferred mode", async () => {
    vi.stubEnv("QR_INFERRED_GATEWAY_TOKEN", "inferred-token");
    setLocalAuth(
      { token: secretRef("QR_INFERRED_GATEWAY_TOKEN"), password: missingPassword },
      "gateway.local",
    );

    await expectQrExit(["--setup-code-only"]);
    expect(errorText()).toContain("gateway.auth.mode is unset");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("rejects invalid gateway.remote.url before printing remote setup codes", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        ...createTokenGatewayConfig().gateway,
        remote: { url: "http://localhost:notaport", token: "remote-tok" },
        auth: { mode: "token", token: "local-tok" },
      },
    });

    await expectQrExit(["--setup-code-only", "--remote"]);

    expect(errorText()).toContain("Configured gateway.remote.url is invalid.");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("logs remote secret diagnostics in non-json output mode", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.token inactive"] as string[],
    });

    await runQr(["--remote"]);

    expect(runtimeLog.mock.calls.map(readRuntimeCallText).join("\n")).toContain(
      "gateway.remote.token inactive",
    );
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
    expect(errorText()).toContain("gateway.remote.password inactive");
  });

  it("errors when --remote is set but no remote URL is configured", async () => {
    loadConfig.mockReturnValue(createTokenGatewayConfig("gateway.local"));

    await expectQrExit(["--remote"]);
    expect(errorText()).toContain("qr --remote requires");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("preserves --remote Tailscale Serve with publicOrigin and no remote URL", async () => {
    const gateway = {
      publicOrigin: "https://gateway.example.test",
      tailscale: { mode: "serve" },
      auth: {},
    };
    loadConfig.mockReturnValue({
      gateway: { ...gateway, remote: { token: secretRef("REMOTE_GATEWAY_TOKEN") } },
    });
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {
        gateway: { ...gateway, remote: { token: "tailscale-remote-token" } },
      },
      diagnostics: [],
    });
    mockTailscaleStatusLookup();

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload).toMatchObject({
      gatewayUrl: "wss://ts-host.tailnet.ts.net",
      auth: "token",
      urlSource: "gateway.tailscale.mode=serve",
    });
  });
});
