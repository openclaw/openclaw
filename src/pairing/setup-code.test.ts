import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";
import {
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));

const { decodePairingSetupCode, encodePairingSetupCode, resolvePairingSetupFromConfig } =
  await import("./setup-code.js");
const { issueDevicePairSetupBootstrapToken: issueDevicePairSetupBootstrapTokenMock } =
  await import("../infra/device-bootstrap.js");

const TLS_FINGERPRINT = "ab".repeat(32);
const COLON_TLS_FINGERPRINT = (TLS_FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();

describe("pairing setup code", () => {
  it("round-trips setup codes while canonicalizing their TLS fingerprint", () => {
    const payload = {
      url: "wss://gateway.example:8443/openclaw-gw",
      bootstrapToken: "Bootstrap-AbC123",
      tlsFingerprint: `SHA256:${COLON_TLS_FINGERPRINT}`,
      expiresAtMs: 20_000,
    };
    const setupCode = encodePairingSetupCode(payload);
    expect(setupCode).toMatch(/[A-Z]/u);

    const expected = { ...payload, tlsFingerprint: TLS_FINGERPRINT };
    expect(decodePairingSetupCode(setupCode, { nowMs: 10_000 })).toEqual(expected);
    expect(decodePairingSetupCode(`oc-pair://${setupCode}`, { nowMs: 10_000 })).toEqual(expected);
  });

  it("rejects an invalid TLS fingerprint in a setup code", () => {
    const setupCode = encodePairingSetupCode({
      url: "wss://gateway.example",
      bootstrapToken: "bootstrap-123",
      tlsFingerprint: "sha256:abc123",
    });
    expect(() => decodePairingSetupCode(setupCode)).toThrow("Invalid pairing setup payload");
  });

  it("rejects garbage and expired shipped payload shapes", () => {
    expect(() => decodePairingSetupCode("not-json")).toThrow("Invalid pairing setup");
    const expired = encodePairingSetupCode({
      url: "wss://gateway.example",
      bootstrapToken: "bootstrap-123",
      expiresAtMs: 10_000,
    });
    expect(() => decodePairingSetupCode(expired, { nowMs: 10_000 })).toThrow("expired");
  });

  it("accepts older payloads without a TLS fingerprint or expiry", () => {
    const payload = { url: "wss://gateway.example", bootstrapToken: "bootstrap-123" };
    expect(decodePairingSetupCode(encodePairingSetupCode(payload))).toEqual(payload);
  });

  type ResolvedSetup = Awaited<ReturnType<typeof resolvePairingSetupFromConfig>>;
  type ResolveSetupConfig = Parameters<typeof resolvePairingSetupFromConfig>[0];
  type ResolveSetupOptions = Parameters<typeof resolvePairingSetupFromConfig>[1];
  const defaultEnvSecretProviderConfig = {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as const;
  const limitedPlaintextAccess = {
    bootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
    access: "limited" as const,
    accessDowngraded: true,
  };
  const secret = (id: string, provider = "default"): SecretInput => ({
    source: "env",
    provider,
    id,
  });
  const missingGatewayTokenSecretRef = secret("MISSING_GW_TOKEN");

  function gatewayConfig(gateway: NonNullable<ResolveSetupConfig["gateway"]>): ResolveSetupConfig {
    return { gateway: { auth: { mode: "token", token: "tok_123" }, ...gateway } };
  }

  function createCustomGatewayConfig(
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"] = { mode: "token", token: "tok_123" },
    config: Omit<ResolveSetupConfig, "gateway"> = {},
    gateway: NonNullable<ResolveSetupConfig["gateway"]> = {},
  ): ResolveSetupConfig {
    return {
      ...config,
      gateway: { bind: "custom", customBindHost: "127.0.0.1", auth, ...gateway },
    };
  }

  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));
  }

  function createDefaultRouteRunner(interfaceName: string) {
    const stdout =
      process.platform === "win32"
        ? JSON.stringify({ InterfaceAlias: interfaceName })
        : process.platform === "linux"
          ? `default via 10.211.55.1 dev ${interfaceName} proto dhcp metric 100\n`
          : `   route to: default\ninterface: ${interfaceName}\n`;
    return vi.fn(async () => ({
      code: 0,
      stdout,
      stderr: "",
    }));
  }

  function createIpv4NetworkInterfaces(
    address: string,
    name = "en0",
  ): ReturnType<NonNullable<NonNullable<ResolveSetupOptions>["networkInterfaces"]>> {
    return {
      [name]: [
        {
          address,
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: `${address}/24`,
        },
      ],
    };
  }

  function expectResolvedSetupOk(
    resolved: ResolvedSetup,
    params: {
      authLabel: string;
      url?: string;
      urlSource?: string;
      bootstrapProfile?: { roles: string[]; scopes: string[]; purpose?: string };
      access?: "full" | "limited" | "node";
      accessDowngraded?: boolean;
    },
  ) {
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved).toMatchObject({
      authLabel: params.authLabel,
      setupId: "setup-123",
      expiresAtMs: 123,
      access: params.access ?? "full",
      accessDowngraded: params.accessDowngraded ?? false,
    });
    expect(resolved.payload).toEqual({
      url: params.url ?? expect.any(String),
      bootstrapToken: "bootstrap-123",
      expiresAtMs: 123,
    });
    expect(resolved.payload).not.toHaveProperty("setupId");
    expect(issueDevicePairSetupBootstrapTokenMock).toHaveBeenCalledWith({
      baseDir: undefined,
      profile: params.bootstrapProfile ?? {
        roles: ["node", "operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "mobile-full",
      },
    });
    if (params.urlSource) {
      expect(resolved.urlSource).toBe(params.urlSource);
    }
  }

  async function expectSetup(
    config: ResolveSetupConfig,
    options: ResolveSetupOptions,
    expected: Parameters<typeof expectResolvedSetupOk>[1],
    commandCalls?: number,
  ) {
    expectResolvedSetupOk(await resolvePairingSetupFromConfig(config, options), expected);
    if (commandCalls !== undefined) {
      expect(options?.runCommandWithTimeout).toHaveBeenCalledTimes(commandCalls);
    }
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.mocked(issueDevicePairSetupBootstrapTokenMock).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  type UrlCase = {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    url: string;
    urlSource?: string;
  };
  it.each<UrlCase>([
    ...["https://gateway.example:8444", "https://gateway.example:8444/proxy"].map((publicUrl) => ({
      config: {
        ...gatewayConfig({ bind: "loopback", controlUi: { basePath: "/gateway" } }),
        plugins: { entries: { "device-pair": { config: { publicUrl } } } },
      },
      url: `wss://gateway.example:8444${publicUrl.endsWith("/proxy") ? "/proxy" : "/gateway"}`,
    })),
    {
      config: gatewayConfig({ controlUi: { basePath: "/gateway" } }),
      options: {
        publicUrl: "wss://override.example",
        localTlsFingerprint: `sha256:${COLON_TLS_FINGERPRINT}`,
      },
      url: "wss://override.example",
    },
    {
      config: gatewayConfig({
        bind: "loopback",
        controlUi: { basePath: "/gateway" },
        tailscale: { mode: "serve" },
      }),
      options: { runCommandWithTimeout: createTailnetDnsRunner() },
      url: "wss://mb-server.tailnet.ts.net/gateway",
    },
    {
      config: gatewayConfig({
        bind: "loopback",
        controlUi: { basePath: "/gateway" },
        publicOrigin: "https://gateway.example",
      }),
      url: "wss://gateway.example/gateway",
    },
    {
      config: gatewayConfig({
        controlUi: { basePath: "/gateway" },
        remote: { url: "wss://remote.example" },
        tailscale: { mode: "serve" },
      }),
      options: { preferRemoteUrl: true },
      url: "wss://remote.example",
    },
  ])(
    "preserves the selected endpoint's context path: $url",
    async ({ config, options, url, urlSource }) => {
      expectResolvedSetupOk(await resolvePairingSetupFromConfig(config, options), {
        authLabel: "token",
        url,
        urlSource,
      });
    },
  );

  it.each([
    { bootstrapProfile: { roles: ["node"], scopes: [] }, access: "node" as const },
    { bootstrapProfile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE, access: "limited" as const },
  ])("issues the requested $access bootstrap profile", async ({ bootstrapProfile, access }) => {
    await expectSetup(
      createCustomGatewayConfig(),
      {
        forceSecure: true,
        publicUrl: "gateway.example.test:18789/setup",
        bootstrapProfile,
      },
      {
        authLabel: "token",
        url: "wss://gateway.example.test:18789",
        urlSource: "plugins.entries.device-pair.config.publicUrl",
        bootstrapProfile,
        access,
      },
    );
  });

  it.each<[string, ResolveSetupConfig, ResolveSetupOptions, string]>([
    [
      "invalid remote URL",
      createCustomGatewayConfig(undefined, {}, { remote: { url: "http://localhost:notaport" } }),
      { preferRemoteUrl: true },
      "Configured gateway.remote.url is invalid.",
    ],
    ...[
      "http:gateway.example.test",
      "mailto:foo@example.com",
      "ws://user:pass@gateway.example.test:18789",
    ].map((publicUrl): [string, ResolveSetupConfig, ResolveSetupOptions, string] => [
      `invalid public URL ${publicUrl}`,
      createCustomGatewayConfig(),
      { forceSecure: true, publicUrl },
      "Configured publicUrl is invalid.",
    ]),
    [
      "no auth",
      createCustomGatewayConfig({}),
      { env: {} },
      "Gateway auth is not configured (no token or password).",
    ],
    [
      "disabled auth",
      createCustomGatewayConfig({ mode: "none" }),
      { env: {} },
      'Pairing setup requires gateway.auth.mode "token" or "password"; current mode is "none".',
    ],
    [
      "public cleartext",
      gatewayConfig({ bind: "custom", customBindHost: "gateway.example" }),
      undefined,
      "Tailscale and public mobile pairing require a secure gateway URL",
    ],
    [
      "tailnet cleartext",
      gatewayConfig({ bind: "tailnet" }),
      { networkInterfaces: () => createIpv4NetworkInterfaces("100.64.0.9") },
      "prefer gateway.tailscale.mode=serve",
    ],
    ["loopback-only", gatewayConfig({ bind: "loopback" }), undefined, "only bound to loopback"],
    [
      "invalid TLS pin",
      createCustomGatewayConfig(undefined, {}, { tls: { enabled: true } }),
      { localTlsFingerprint: "sha256:abc123" },
      "TLS fingerprint is invalid",
    ],
  ])("rejects %s before issuing a setup token", async (_name, config, options, expectedError) => {
    expect(await resolvePairingSetupFromConfig(config, options)).toEqual({
      ok: false,
      error: expect.stringContaining(expectedError),
    });
    expect(issueDevicePairSetupBootstrapTokenMock).not.toHaveBeenCalled();
  });

  type AuthCase = {
    name: string;
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env: NodeJS.ProcessEnv;
    authLabel: string;
  };
  it.each<AuthCase>([
    {
      name: "inactive password SecretRef",
      auth: {
        mode: "token",
        token: "tok_123",
        password: secret("GW_PASSWORD", "missing"),
      },
      env: {},
      authLabel: "token",
    },
    {
      name: "inferred password with an unresolved token",
      auth: { token: "${MISSING_GW_TOKEN}" },
      env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
      authLabel: "password",
    },
  ])("resolves $name", async ({ auth, env, authLabel }) => {
    expectResolvedSetupOk(
      await resolvePairingSetupFromConfig(
        createCustomGatewayConfig(auth, defaultEnvSecretProviderConfig),
        { env },
      ),
      { authLabel },
    );
  });

  it.each([
    {
      auth: { mode: "token", token: missingGatewayTokenSecretRef },
      env: {},
      error: "MISSING_GW_TOKEN",
    },
    {
      auth: {
        mode: "password",
        password: secret("MISSING_GW_PASSWORD"),
      },
      env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
      error: "MISSING_GW_PASSWORD",
    },
    {
      auth: { token: missingGatewayTokenSecretRef, password: secret("GW_PASSWORD") },
      env: { GW_PASSWORD: "resolved-password" },
      error: /gateway\.auth\.mode is unset/i,
    },
  ] as const)(
    "rejects unresolved or ambiguous credentials: $error",
    async ({ auth, env, error }) => {
      await expect(
        resolvePairingSetupFromConfig(
          createCustomGatewayConfig(auth, defaultEnvSecretProviderConfig),
          { env },
        ),
      ).rejects.toThrow(error);
    },
  );

  it.each([
    { bind: "custom", host: "gateway.local", port: 18789, secure: false, limited: true },
    { bind: "tailnet", host: "100.64.0.9", port: 18789, secure: true, limited: false },
  ] as const)(
    "resolves $bind $host without discovering legacy Serve routes",
    async ({ bind, host, port, secure, limited }) => {
      const runCommandWithTimeout = vi.fn(async () => {
        throw new Error("Tailscale Serve discovery must not run for a direct bind");
      });
      await expectSetup(
        gatewayConfig({
          bind,
          customBindHost: bind === "custom" ? host : undefined,
          port,
          tls: { enabled: secure },
        }),
        {
          runCommandWithTimeout,
          networkInterfaces: () => createIpv4NetworkInterfaces(host),
        },
        {
          authLabel: "token",
          url: `${secure ? "wss" : "ws"}://${host}:${port}`,
          urlSource: `gateway.bind=${bind}`,
          ...(limited ? limitedPlaintextAccess : {}),
        },
        0,
      );
    },
  );

  it("advertises the routed LAN address ahead of a private bridge", async () => {
    const route = createDefaultRouteRunner("en1");
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
      if (argv.includes("serve")) {
        throw new Error("legacy Serve discovery must not run for a LAN bind");
      }
      return route();
    });
    await expectSetup(
      gatewayConfig({ bind: "lan", auth: { mode: "password", password: "secret" } }),
      {
        networkInterfaces: () => ({
          ...createIpv4NetworkInterfaces("10.37.129.4", "bridge100"),
          ...createIpv4NetworkInterfaces("10.211.55.3", "en1"),
        }),
        runCommandWithTimeout,
      },
      {
        authLabel: "password",
        url: "ws://10.211.55.3:18789",
        urlSource: "gateway.bind=lan",
        ...limitedPlaintextAccess,
      },
      1,
    );
  });

  it.each([false, true])(
    "keeps local server pairing on its own endpoint and TLS pin (local=%s)",
    async (useLocalGateway) => {
      const config = createCustomGatewayConfig(
        { mode: "token", token: "local-token" },
        {},
        {
          mode: "remote",
          port: 19443,
          tls: { enabled: true },
          remote: { url: "wss://primary.example", tlsFingerprint: "cd".repeat(32) },
        },
      );
      const resolved = await resolvePairingSetupFromConfig(config, {
        env: {},
        useLocalGateway,
        localTlsFingerprint: `sha256:${COLON_TLS_FINGERPRINT}`,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      expect(resolved.payload.url).toBe(
        useLocalGateway ? "wss://127.0.0.1:19443" : "wss://primary.example",
      );
      expect(resolved.payload.tlsFingerprint).toBe(
        useLocalGateway ? TLS_FINGERPRINT : "cd".repeat(32),
      );
    },
  );

  it("omits a configured remote TLS pin from a cleartext setup URL", async () => {
    const config = createCustomGatewayConfig(
      undefined,
      {},
      {
        remote: {
          url: "ws://127.0.0.1:18789",
          tlsFingerprint: `sha256:${TLS_FINGERPRINT}`,
        },
      },
    );

    const resolved = await resolvePairingSetupFromConfig(config, { preferRemoteUrl: true });

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.payload.tlsFingerprint).toBeUndefined();
  });
});
