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
  const gatewayPasswordSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "GW_PASSWORD",
  };
  const missingGatewayTokenSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "MISSING_GW_TOKEN",
  };

  function gatewayConfig(gateway: NonNullable<ResolveSetupConfig["gateway"]>): ResolveSetupConfig {
    return { gateway: { auth: { mode: "token", token: "tok_123" }, ...gateway } };
  }

  function createCustomGatewayConfig(
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"],
    config: Omit<ResolveSetupConfig, "gateway"> = {},
  ): ResolveSetupConfig {
    return {
      ...config,
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        auth,
      },
    };
  }

  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));
  }

  function createNoRouteRunner() {
    return vi.fn(async () => ({
      code: 1,
      stdout: "",
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
    expect(resolved.authLabel).toBe(params.authLabel);
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(resolved.setupId).toBe("setup-123");
    expect(resolved.expiresAtMs).toBe(123);
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
    expect(resolved.payload).not.toHaveProperty("setupId");
    expect(resolved.payload).toHaveProperty("expiresAtMs", 123);
    if (params.url) {
      expect(resolved.payload.url).toBe(params.url);
    }
    if (params.urlSource) {
      expect(resolved.urlSource).toBe(params.urlSource);
    }
    expect(resolved.access).toBe(params.access ?? "full");
    expect(resolved.accessDowngraded).toBe(params.accessDowngraded ?? false);
  }

  function expectResolvedSetupError(resolved: ResolvedSetup, snippet: string) {
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain(snippet);
  }

  async function expectResolvedSetupSuccessCase(params: {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expected: Parameters<typeof expectResolvedSetupOk>[1];
    runCommandWithTimeout?: ReturnType<typeof vi.fn>;
    expectedRunCommandCalls?: number;
  }) {
    const resolved = await resolvePairingSetupFromConfig(params.config, params.options);
    expectResolvedSetupOk(resolved, params.expected);
    if (params.runCommandWithTimeout) {
      expect(params.runCommandWithTimeout).toHaveBeenCalledTimes(
        params.expectedRunCommandCalls ?? 0,
      );
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
    {
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: { publicUrl: "wss://gateway.example.test:18789/openclaw-gw" },
      url: "wss://gateway.example.test:18789/openclaw-gw",
      urlSource: "plugins.entries.device-pair.config.publicUrl",
    },
    ...[undefined, "", "/", "/gateway", " gateway/ "].map((basePath) => ({
      config: gatewayConfig({
        bind: "custom",
        customBindHost: "127.0.0.1",
        controlUi: { basePath },
      }),
      options: { env: {} },
      url: `ws://127.0.0.1:18789${basePath?.includes("gateway") ? "/gateway" : ""}`,
    })),
    ...["https://gateway.example:8444", "https://gateway.example:8444/proxy"].map((publicUrl) => ({
      config: {
        ...gatewayConfig({ bind: "loopback", controlUi: { basePath: "/gateway" } }),
        plugins: { entries: { "device-pair": { config: { publicUrl } } } },
      },
      url: `wss://gateway.example:8444${publicUrl.endsWith("/proxy") ? "/proxy" : "/gateway"}`,
    })),
    ...["wss://override.example", "wss://override.example/proxy"].map((publicUrl) => ({
      config: gatewayConfig({ controlUi: { basePath: "/gateway" } }),
      options: { publicUrl },
      url: publicUrl,
    })),
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
    await expectResolvedSetupSuccessCase({
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: {
        forceSecure: true,
        publicUrl: "gateway.example.test:18789/setup",
        bootstrapProfile,
      },
      expected: {
        authLabel: "token",
        url: "wss://gateway.example.test:18789",
        urlSource: "plugins.entries.device-pair.config.publicUrl",
        bootstrapProfile,
        access,
      },
    });
  });

  type ErrorCase = {
    name: string;
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expectedError: string;
  };
  it.each<ErrorCase>([
    {
      name: "invalid remote URL",
      config: gatewayConfig({
        bind: "custom",
        customBindHost: "127.0.0.1",
        remote: { url: "http://localhost:notaport" },
      }),
      options: { preferRemoteUrl: true },
      expectedError: "Configured gateway.remote.url is invalid.",
    },
    ...[
      "localhost:notaport",
      "http://localhost:notaport",
      "http:gateway.example.test",
      "ftp:/gateway.example.test",
      "mailto:foo@example.com",
      "ws://user:pass@gateway.example.test:18789",
    ].map((publicUrl) => ({
      name: `invalid public URL ${publicUrl}`,
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: { forceSecure: true, publicUrl },
      expectedError: "Configured publicUrl is invalid.",
    })),
    {
      name: "no auth",
      config: createCustomGatewayConfig({}),
      options: { env: {} },
      expectedError: "Gateway auth is not configured (no token or password).",
    },
    {
      name: "disabled auth",
      config: createCustomGatewayConfig({ mode: "none" }),
      options: { env: {} },
      expectedError:
        'Pairing setup requires gateway.auth.mode "token" or "password"; current mode is "none".',
    },
    {
      name: "public cleartext",
      config: gatewayConfig({ bind: "custom", customBindHost: "gateway.example" }),
      expectedError: "Tailscale and public mobile pairing require a secure gateway URL",
    },
    {
      name: "tailnet cleartext",
      config: gatewayConfig({ bind: "tailnet" }),
      options: { networkInterfaces: () => createIpv4NetworkInterfaces("100.64.0.9") },
      expectedError: "prefer gateway.tailscale.mode=serve",
    },
    {
      name: "loopback-only",
      config: gatewayConfig({ bind: "loopback", auth: { mode: "token", token: "tok" } }),
      expectedError: "only bound to loopback",
    },
    {
      name: "failed interface discovery",
      config: gatewayConfig({ bind: "lan", auth: { mode: "token", token: "tok" } }),
      options: {
        networkInterfaces: () => {
          throw new Error("uv_interface_addresses failed");
        },
      },
      expectedError: "gateway.bind=lan set, but no private LAN IP was found.",
    },
    {
      name: "invalid TLS pin",
      config: gatewayConfig({
        bind: "custom",
        customBindHost: "127.0.0.1",
        tls: { enabled: true },
      }),
      options: { localTlsFingerprint: "sha256:abc123" },
      expectedError: "TLS fingerprint is invalid",
    },
  ])("rejects $name before issuing a setup token", async ({ config, options, expectedError }) => {
    expectResolvedSetupError(await resolvePairingSetupFromConfig(config, options), expectedError);
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
      name: "password SecretRef",
      auth: { mode: "password", password: gatewayPasswordSecretRef },
      env: { GW_PASSWORD: "resolved-password" },
      authLabel: "password",
    },
    {
      name: "inactive password SecretRef",
      auth: {
        mode: "token",
        token: "tok_123",
        password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
      },
      env: {},
      authLabel: "token",
    },
    {
      name: "token SecretRef",
      auth: { mode: "token", token: { source: "env", provider: "default", id: "GW_TOKEN" } },
      env: { GW_TOKEN: "resolved-token" },
      authLabel: "token",
    },
    {
      name: "trusted proxy password fallback",
      auth: { mode: "trusted-proxy", password: "secret" },
      env: {},
      authLabel: "password",
    },
    ...[missingGatewayTokenSecretRef, "${MISSING_GW_TOKEN}"].map((token) => ({
      name: `inferred password with ${typeof token} token`,
      auth: { token },
      env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
      authLabel: "password",
    })),
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
        password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
      },
      env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
      error: "MISSING_GW_PASSWORD",
    },
    {
      auth: { token: missingGatewayTokenSecretRef, password: gatewayPasswordSecretRef },
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
    { bind: "custom", host: "127.0.0.1", port: 19001, secure: false, limited: false },
    { bind: "custom", host: "10.0.2.2", port: 18789, secure: false, limited: true },
    { bind: "custom", host: "gateway.local", port: 18789, secure: false, limited: true },
    { bind: "tailnet", host: "100.64.0.9", port: 18789, secure: true, limited: false },
  ] as const)(
    "resolves $bind $host without discovering legacy Serve routes",
    async ({ bind, host, port, secure, limited }) => {
      const runCommandWithTimeout = vi.fn(async () => {
        throw new Error("Tailscale Serve discovery must not run for a direct bind");
      });
      await expectResolvedSetupSuccessCase({
        config: gatewayConfig({
          bind,
          customBindHost: bind === "custom" ? host : undefined,
          port,
          tls: { enabled: secure },
        }),
        options: {
          runCommandWithTimeout,
          networkInterfaces: () => createIpv4NetworkInterfaces(host),
        },
        expected: {
          authLabel: "token",
          url: `${secure ? "wss" : "ws"}://${host}:${port}`,
          urlSource: `gateway.bind=${bind}`,
          ...(limited ? limitedPlaintextAccess : {}),
        },
        runCommandWithTimeout,
        expectedRunCommandCalls: 0,
      });
    },
  );

  it.each([
    {
      name: "single address without route probing",
      interfaces: createIpv4NetworkInterfaces("192.168.1.20"),
      routedInterface: undefined,
      host: "192.168.1.20",
      probes: 0,
    },
    {
      name: "routed address ahead of a private bridge",
      interfaces: {
        ...createIpv4NetworkInterfaces("10.37.129.4", "bridge100"),
        ...createIpv4NetworkInterfaces("10.211.55.3", "en1"),
      },
      routedInterface: "en1",
      host: "10.211.55.3",
      probes: 1,
    },
  ])(
    "advertises the LAN $name, never a legacy Serve route",
    async ({ interfaces, routedInterface, host, probes }) => {
      const route = routedInterface
        ? createDefaultRouteRunner(routedInterface)
        : createNoRouteRunner();
      const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
        if (argv.includes("serve")) {
          throw new Error("legacy Serve discovery must not run for a LAN bind");
        }
        return route();
      });
      await expectResolvedSetupSuccessCase({
        config: gatewayConfig({ bind: "lan", auth: { mode: "password", password: "secret" } }),
        options: { networkInterfaces: () => interfaces, runCommandWithTimeout },
        expected: {
          authLabel: "password",
          url: `ws://${host}:18789`,
          urlSource: "gateway.bind=lan",
          ...limitedPlaintextAccess,
        },
        runCommandWithTimeout,
        expectedRunCommandCalls: probes,
      });
    },
  );

  it.each([
    {
      name: "uses tailscale serve DNS when available",
      gateway: { auth: { mode: "password", password: "secret" } },
      preferRemoteUrl: false,
      expectedRunCommandCalls: 1,
      expected: {
        authLabel: "password",
        url: "wss://mb-server.tailnet.ts.net",
        urlSource: "gateway.tailscale.mode=serve",
      },
    },
    {
      name: "prefers gateway.remote.url over tailscale when requested",
      gateway: { remote: { url: "wss://remote.example.com:444" } },
      preferRemoteUrl: true,
      expectedRunCommandCalls: 0,
      expected: {
        authLabel: "token",
        url: "wss://remote.example.com:444",
        urlSource: "gateway.remote.url",
      },
    },
  ] as const)("$name", async ({ gateway, preferRemoteUrl, expectedRunCommandCalls, expected }) => {
    const runCommandWithTimeout = createTailnetDnsRunner();
    await expectResolvedSetupSuccessCase({
      config: gatewayConfig({ tailscale: { mode: "serve" }, ...gateway }),
      options: { preferRemoteUrl, runCommandWithTimeout },
      expected,
      runCommandWithTimeout,
      expectedRunCommandCalls,
    });
  });

  it.each([false, true])(
    "keeps local server pairing on its own endpoint and TLS pin (local=%s)",
    async (useLocalGateway) => {
      const config = createCustomGatewayConfig({ mode: "token", token: "local-token" });
      config.gateway = {
        ...config.gateway,
        mode: "remote",
        port: 19443,
        tls: { enabled: true },
        remote: { url: "wss://primary.example", tlsFingerprint: "cd".repeat(32) },
      };
      const resolved = await resolvePairingSetupFromConfig(config, {
        env: {},
        useLocalGateway,
        localTlsFingerprint: TLS_FINGERPRINT,
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

  it("pins the prepared leaf only for a direct TLS gateway URL", async () => {
    const config = createCustomGatewayConfig({ mode: "token", token: "tok_123" });
    config.gateway = { ...config.gateway, tls: { enabled: true } };
    const direct = await resolvePairingSetupFromConfig(config, {
      localTlsFingerprint: `sha256:${COLON_TLS_FINGERPRINT}`,
    });
    const proxied = await resolvePairingSetupFromConfig(config, {
      publicUrl: "wss://proxy.example",
      localTlsFingerprint: `sha256:${COLON_TLS_FINGERPRINT}`,
    });

    expect(direct.ok && direct.payload.tlsFingerprint).toBe(TLS_FINGERPRINT);
    expect(proxied.ok && proxied.payload.tlsFingerprint).toBeUndefined();
  });

  it("omits a configured remote TLS pin from a cleartext setup URL", async () => {
    const config = createCustomGatewayConfig({ mode: "token", token: "tok_123" });
    config.gateway = {
      ...config.gateway,
      remote: {
        url: "ws://127.0.0.1:18789",
        tlsFingerprint: `sha256:${TLS_FINGERPRINT}`,
      },
    };

    const resolved = await resolvePairingSetupFromConfig(config, { preferRemoteUrl: true });

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.payload.tlsFingerprint).toBeUndefined();
  });
});
