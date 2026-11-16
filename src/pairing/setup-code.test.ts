import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";
import {
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));
const {
  decodePairingSetupCode: decode,
  encodePairingSetupCode: encode,
  resolvePairingSetupFromConfig: resolve,
} = await import("./setup-code.js");
const { issueDevicePairSetupBootstrapToken: issueToken } =
  await import("../infra/device-bootstrap.js");

type Config = Parameters<typeof resolve>[0];
type Gateway = NonNullable<Config["gateway"]>;
type Options = NonNullable<Parameters<typeof resolve>[1]>;
type Success = Extract<Awaited<ReturnType<typeof resolve>>, { ok: true }>;
type Expected = Partial<
  Pick<Success, "authLabel" | "urlSource" | "access" | "accessDowngraded">
> & {
  url?: string;
  tlsFingerprint?: string;
  profile?: Options["bootstrapProfile"];
};
const TLS_FINGERPRINT = "ab".repeat(32);
const COLON_TLS_FINGERPRINT = (TLS_FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();
const PAYLOAD = { url: "wss://gateway.example", bootstrapToken: "bootstrap-123" };
const limited = {
  profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
  access: "limited",
  accessDowngraded: true,
} as const;
const secret = (id: string, provider = "default"): SecretInput => ({ source: "env", provider, id });
const noDiscovery = vi.fn(async () => {
  throw new Error("Tailscale discovery must not run for a direct bind");
});

function config(gateway: Gateway = {}, extra: Omit<Config, "gateway"> = {}): Config {
  return { ...extra, gateway: { auth: { mode: "token", token: "tok_123" }, ...gateway } };
}
function custom(gateway: Gateway = {}, extra?: Omit<Config, "gateway">) {
  return config({ bind: "custom", customBindHost: "127.0.0.1", ...gateway }, extra);
}
function mounted(gateway: Gateway = {}, extra?: Omit<Config, "gateway">) {
  return config({ controlUi: { basePath: "/gateway" }, ...gateway }, extra);
}
function command(stdout: string) {
  return vi.fn(async () => ({ code: 0, stdout, stderr: "" }));
}
function publicConfig(publicUrl: string) {
  return mounted(
    { bind: "loopback" },
    { plugins: { entries: { "device-pair": { config: { publicUrl } } } } },
  );
}
function ipv4(address: string, name = "en0") {
  return makeNetworkInterfacesSnapshot({
    [name]: [{ address, family: "IPv4", netmask: "255.255.255.0" }],
  });
}
async function checkSetup(cfg: Config, expected: Expected = {}, options?: Options) {
  const resolved = await resolve(cfg, options);
  assert.ok(resolved.ok);
  const { url, tlsFingerprint, profile, ...fields } = expected;
  expect(resolved).toMatchObject({
    authLabel: "token",
    access: "full",
    accessDowngraded: false,
    setupId: "setup-123",
    expiresAtMs: 123,
    ...fields,
  });
  expect(resolved.payload).toEqual({
    url: url ?? expect.any(String),
    bootstrapToken: "bootstrap-123",
    expiresAtMs: 123,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
  });
  expect(issueToken).toHaveBeenCalledWith({
    profile: profile ?? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
}
beforeEach(() => {
  for (const key of [
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_GATEWAY_PORT",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.mocked(issueToken).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

it("round-trips setup codes while canonicalizing their TLS fingerprint", () => {
  const payload = {
    url: "wss://gateway.example:8443/openclaw-gw",
    bootstrapToken: "Bootstrap-AbC123",
    tlsFingerprint: "SHA256:" + COLON_TLS_FINGERPRINT,
    expiresAtMs: 20_000,
  };
  const code = encode(payload);
  const expected = { ...payload, tlsFingerprint: TLS_FINGERPRINT };
  expect(decode(code, { nowMs: 10_000 })).toEqual(expected);
  expect(decode("oc-pair://" + code, { nowMs: 10_000 })).toEqual(expected);
});
it("rejects an invalid TLS fingerprint in a setup code", () => {
  expect(() => decode(encode({ ...PAYLOAD, tlsFingerprint: "sha256:abc123" }))).toThrow(
    "Invalid pairing setup payload",
  );
});
it("rejects garbage and expired shipped payload shapes", () => {
  expect(() => decode("not-json")).toThrow("Invalid pairing setup");
  expect(() => decode(encode({ ...PAYLOAD, expiresAtMs: 10_000 }), { nowMs: 10_000 })).toThrow(
    "expired",
  );
});
it("accepts older payloads without a TLS fingerprint or expiry", () => {
  expect(decode(encode(PAYLOAD))).toEqual(PAYLOAD);
});

it.each<[Config, Options | undefined, string | Expected]>([
  [publicConfig("https://gateway.example:8444"), undefined, "wss://gateway.example:8444/gateway"],
  [
    publicConfig("https://gateway.example:8444/proxy"),
    undefined,
    "wss://gateway.example:8444/proxy",
  ],
  [
    mounted(),
    { publicUrl: "wss://override.example", localTlsFingerprint: "sha256:" + COLON_TLS_FINGERPRINT },
    "wss://override.example",
  ],
  [
    mounted({ bind: "loopback", tailscale: { mode: "serve" } }),
    { runCommandWithTimeout: command('{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}') },
    "wss://mb-server.tailnet.ts.net/gateway",
  ],
  [
    mounted({ bind: "loopback", publicOrigin: "https://gateway.example" }),
    undefined,
    "wss://gateway.example/gateway",
  ],
  [
    mounted({ remote: { url: "wss://remote.example" }, tailscale: { mode: "serve" } }),
    { preferRemoteUrl: true },
    "wss://remote.example",
  ],
  ...(
    [
      ["custom", "gateway.local", false],
      ["tailnet", "100.64.0.9", true],
    ] as const
  ).map(([bind, host, secure]): [Config, Options, Expected] => [
    config({ bind, customBindHost: host, tls: { enabled: secure } }),
    { runCommandWithTimeout: noDiscovery, networkInterfaces: () => ipv4(host) },
    {
      url: `${secure ? "wss" : "ws"}://${host}:18789`,
      urlSource: `gateway.bind=${bind}`,
      ...(secure ? {} : limited),
    },
  ]),
])("preserves the selected endpoint and access: %s", async (cfg, options, expected) => {
  noDiscovery.mockClear();
  await checkSetup(cfg, typeof expected === "string" ? { url: expected } : expected, options);
  expect(noDiscovery).not.toHaveBeenCalled();
});

it.each([
  { profile: { roles: ["node"], scopes: [] }, access: "node" as const },
  { profile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE, access: "limited" as const },
])("issues the requested $access bootstrap profile", ({ profile, access }) =>
  checkSetup(
    custom(),
    {
      url: "wss://gateway.example.test:18789",
      urlSource: "plugins.entries.device-pair.config.publicUrl",
      profile,
      access,
    },
    { forceSecure: true, publicUrl: "gateway.example.test:18789/setup", bootstrapProfile: profile },
  ),
);

it.each<[Config, Options?]>([
  [custom({ remote: { url: "http://localhost:notaport" } }), { preferRemoteUrl: true }],
  ...[
    "http:gateway.example.test",
    "mailto:foo@example.com",
    "ws://user:pass@gateway.example.test:18789",
  ].map((publicUrl): [Config, Options] => [custom(), { forceSecure: true, publicUrl }]),
  [custom({ auth: {} }), { env: {} }],
  [custom({ auth: { mode: "none" } }), { env: {} }],
  [config({ bind: "custom", customBindHost: "gateway.example" })],
  [config({ bind: "tailnet" }), { networkInterfaces: () => ipv4("100.64.0.9") }],
  [config({ bind: "loopback" })],
  [custom({ tls: { enabled: true } }), { localTlsFingerprint: "sha256:abc123" }],
])("rejects %j before issuing a setup token", async (cfg, options) => {
  expect(await resolve(cfg, options)).toEqual({ ok: false, error: expect.any(String) });
  expect(issueToken).not.toHaveBeenCalled();
});

type AuthCase = [
  Gateway["auth"],
  NodeJS.ProcessEnv,
  { authLabel: Success["authLabel"] } | { error: string | RegExp },
];
it.each<AuthCase>([
  [
    { mode: "token", token: "tok_123", password: secret("GW_PASSWORD", "missing") },
    {},
    { authLabel: "token" },
  ],
  [
    { token: "${MISSING_GW_TOKEN}" },
    { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
    { authLabel: "password" },
  ],
  [{ mode: "token", token: secret("MISSING_GW_TOKEN") }, {}, { error: "MISSING_GW_TOKEN" }],
  [
    { mode: "password", password: secret("MISSING_GW_PASSWORD") },
    { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
    { error: "MISSING_GW_PASSWORD" },
  ],
  [
    { token: secret("MISSING_GW_TOKEN"), password: secret("GW_PASSWORD") },
    { GW_PASSWORD: "resolved-password" },
    { error: /gateway\.auth\.mode is unset/i },
  ],
])("resolves or rejects %j", async (auth, env, expected) => {
  const cfg = custom({ auth }, { secrets: { providers: { default: { source: "env" } } } });
  if ("error" in expected) {
    await expect(resolve(cfg, { env })).rejects.toThrow(expected.error);
  } else {
    await checkSetup(cfg, expected, { env });
  }
});

it("advertises the routed LAN address ahead of a private bridge", async () => {
  const runCommandWithTimeout = command(
    process.platform === "win32"
      ? JSON.stringify({ InterfaceAlias: "en1" })
      : process.platform === "linux"
        ? "default via 10.211.55.1 dev en1 proto dhcp metric 100\n"
        : "   route to: default\ninterface: en1\n",
  );
  await checkSetup(
    config({ bind: "lan", auth: { mode: "password", password: "secret" } }),
    {
      authLabel: "password",
      url: "ws://10.211.55.3:18789",
      urlSource: "gateway.bind=lan",
      ...limited,
    },
    {
      networkInterfaces: () => ({
        ...ipv4("10.37.129.4", "bridge100"),
        ...ipv4("10.211.55.3", "en1"),
      }),
      runCommandWithTimeout,
    },
  );
});

it.each([false, true])(
  "keeps local server pairing on its own endpoint and TLS pin (local=%s)",
  async (useLocalGateway) => {
    const cfg = custom({
      auth: { mode: "token", token: "local-token" },
      mode: "remote",
      port: 19443,
      tls: { enabled: true },
      remote: { url: "wss://primary.example", tlsFingerprint: "cd".repeat(32) },
    });
    await checkSetup(
      cfg,
      {
        url: useLocalGateway ? "wss://127.0.0.1:19443" : "wss://primary.example",
        tlsFingerprint: useLocalGateway ? TLS_FINGERPRINT : "cd".repeat(32),
      },
      { env: {}, useLocalGateway, localTlsFingerprint: "sha256:" + COLON_TLS_FINGERPRINT },
    );
  },
);
it("omits a configured remote TLS pin from a cleartext setup URL", async () => {
  await checkSetup(
    custom({
      remote: { url: "ws://127.0.0.1:18789", tlsFingerprint: "sha256:" + TLS_FINGERPRINT },
    }),
    {},
    { preferRemoteUrl: true },
  );
});
