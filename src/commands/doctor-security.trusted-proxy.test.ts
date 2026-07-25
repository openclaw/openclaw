import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  GatewayAuthConfig,
  GatewayControlUiConfig,
  GatewayTrustedProxyConfig,
} from "../config/types.gateway.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(() => []),
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));

// These assertions cover core gateway config only, so avoid compiling plugin-derived targets.
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return {
    ...actual,
    getSecretTargetRegistry: actual.getCoreSecretTargetRegistry,
  };
});

import { noteSecurityWarnings } from "./doctor-security.js";

type TrustedProxyBoundaryOptions = {
  trustedProxies: string[];
  token?: GatewayAuthConfig["token"];
  password?: GatewayAuthConfig["password"];
  trustedProxy?: GatewayTrustedProxyConfig;
  controlUi?: GatewayControlUiConfig;
  localInterfaces?: string[];
  interfaceLookupFails?: boolean;
  bind?: string;
  customBindHost?: string;
  tailscaleMode?: "serve" | "funnel";
  secrets?: OpenClawConfig["secrets"];
  allowExecSecretRefs?: boolean;
};

const trustedProxyBoundaryCases: Array<
  [string, TrustedProxyBoundaryOptions, expectedCritical?: string | string[]]
> = [
  [
    "requires an exposed Control UI origin",
    { trustedProxies: ["192.0.2.10"], controlUi: {} },
    "no explicit browser origin",
  ],
  [
    "does not treat Host-header fallback as an explicit Control UI origin",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
    },
    ["dangerous browser Host-header origin fallback enabled", "no explicit browser origin"],
  ],
  [
    "rejects a malformed Control UI origin",
    { trustedProxies: ["192.0.2.10"], controlUi: { allowedOrigins: ["not-an-origin"] } },
    "no explicit browser origin",
  ],
  [
    "does not treat doctor-seeded loopback origins as proxy UI readiness",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: {
        allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
      },
    },
    "no explicit browser origin for the non-loopback proxy path",
  ],
  [
    "does not let an invalid origin hide Host-header fallback reliance",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: {
        allowedOrigins: ["not-an-origin"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    ["dangerous browser Host-header origin fallback enabled", "no explicit browser origin"],
  ],
  [
    "rejects a Control UI origin with a path-like trailing slash",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { allowedOrigins: ["https://control.example.test/"] },
    },
    "no explicit browser origin",
  ],
  [
    "rejects a noncanonical default-port Control UI origin",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { allowedOrigins: ["https://control.example.test:443"] },
    },
    "no explicit browser origin",
  ],
  [
    "allows a canonical Control UI origin alongside an invalid entry",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { allowedOrigins: ["not-an-origin", "https://control.example.test"] },
    },
  ],
  [
    "rejects Host-header fallback alongside an explicit Control UI origin",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: {
        allowedOrigins: ["https://control.example.test"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    "dangerous browser Host-header origin fallback enabled",
  ],
  [
    "does not treat a wildcard as an explicit Control UI origin",
    { trustedProxies: ["192.0.2.10"], controlUi: { allowedOrigins: [" * "] } },
    'remove "*" from gateway.controlUi.allowedOrigins',
  ],
  [
    "rejects a wildcard mixed with an explicit Control UI origin",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { allowedOrigins: ["*", "https://control.example.test"] },
    },
    'remove "*" from gateway.controlUi.allowedOrigins',
  ],
  [
    "reports wildcard and Host-header fallback together",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: {
        allowedOrigins: ["*"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    [
      'remove "*" from gateway.controlUi.allowedOrigins',
      "dangerous browser Host-header origin fallback enabled",
    ],
  ],
  [
    "allows a disabled Control UI without an explicit origin",
    { trustedProxies: ["192.0.2.10"], controlUi: { enabled: false } },
  ],
  [
    "rejects a wildcard origin even when Control UI assets are disabled",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { enabled: false, allowedOrigins: ["*"] },
    },
    'remove "*" from gateway.controlUi.allowedOrigins',
  ],
  [
    "rejects Host-header fallback even when Control UI assets are disabled",
    {
      trustedProxies: ["192.0.2.10"],
      controlUi: { enabled: false, dangerouslyAllowHostHeaderOriginFallback: true },
    },
    "dangerous browser Host-header origin fallback enabled",
  ],
  [
    "allows an inactive token SecretRef in trusted-proxy mode",
    {
      trustedProxies: ["192.0.2.10"],
      token: { source: "env", provider: "default", id: "UNUSED_GATEWAY_TOKEN" },
    },
  ],
  [
    "rejects a sole host-interface proxy",
    { trustedProxies: ["192.0.2.10"], localInterfaces: ["192.0.2.10"] },
    "No configured proxy source can pass",
  ],
  [
    "rejects a host-interface IPv6 /128",
    { trustedProxies: ["2001:db8::10/128"], localInterfaces: ["2001:db8::10"] },
    "No configured proxy source can pass",
  ],
  [
    "rejects a source when host-interface inspection fails closed",
    { trustedProxies: ["192.0.2.10"], interfaceLookupFails: true },
    "No configured proxy source can pass",
  ],
  [
    "rejects a host-interface /32 with a leading-zero prefix",
    { trustedProxies: ["192.0.2.10/032"], localInterfaces: ["192.0.2.10"] },
    "No configured proxy source can pass",
  ],
  [
    "allows a separate remote proxy",
    { trustedProxies: ["192.0.2.10", "192.0.2.11"], localInterfaces: ["192.0.2.10"] },
  ],
  [
    "rejects a proxy subnet even when it contains a nonlocal address",
    {
      trustedProxies: ["192.0.2.0/24"],
      localInterfaces: ["192.0.2.0", "192.0.2.1", "192.0.2.128", "192.0.2.255"],
    },
    "non-host-scoped CIDR",
  ],
  [
    "reports wildcard origin exposure alongside invalid proxy readiness",
    {
      trustedProxies: ["192.0.2.0/24"],
      controlUi: { allowedOrigins: ["*"] },
    },
    ["non-host-scoped CIDR", 'remove "*" from gateway.controlUi.allowedOrigins'],
  ],
  [
    "reports Host-header fallback alongside invalid proxy readiness",
    {
      trustedProxies: ["not-an-ip"],
      controlUi: {
        allowedOrigins: ["https://control.example.test"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    ["invalid or unusable", "dangerous browser Host-header origin fallback enabled"],
  ],
  [
    "reports missing browser origin alongside invalid proxy readiness",
    {
      trustedProxies: ["0.0.0.0"],
      controlUi: {},
    },
    ["usable unicast", "no explicit browser origin"],
  ],
  [
    "reports invalid header and proxy source together",
    {
      trustedProxies: ["192.0.2.0/24"],
      trustedProxy: { userHeader: "x forwarded user" },
    },
    ["not a valid HTTP header name", "non-host-scoped CIDR"],
  ],
  [
    "reports shared-token conflict and proxy source together",
    {
      trustedProxies: ["192.0.2.0/24"],
      token: "test-token",
    },
    ["mutually exclusive", "non-host-scoped CIDR"],
  ],
  [
    "rejects tailscale serve on an exposed bind",
    { trustedProxies: ["192.0.2.10"], tailscaleMode: "serve" },
    ["fails gateway startup validation", "requires gateway bind=loopback"],
  ],
  [
    "rejects tailscale funnel without password auth",
    { trustedProxies: ["192.0.2.10"], tailscaleMode: "funnel" },
    ["fails gateway startup validation", "funnel requires gateway auth mode=password"],
  ],
  [
    "rejects a custom bind without a custom host",
    { trustedProxies: ["192.0.2.10"], bind: "custom" },
    ["fails gateway startup validation", "requires gateway.customBindHost"],
  ],
  [
    "rejects a custom bind with an invalid host",
    { trustedProxies: ["192.0.2.10"], bind: "custom", customBindHost: "not-an-ip" },
    ["fails gateway startup validation", "valid IPv4"],
  ],
  [
    "allows a bindable custom host with a remote proxy",
    { trustedProxies: ["192.0.2.10"], bind: "custom", customBindHost: "0.0.0.0" },
  ],
  [
    "reports startup and proxy-source problems together",
    { trustedProxies: ["192.0.2.0/24"], tailscaleMode: "serve" },
    ["fails gateway startup validation", "non-host-scoped CIDR"],
  ],
  [
    "rejects an unresolvable trusted-proxy password SecretRef",
    {
      trustedProxies: ["192.0.2.10"],
      password: { source: "env", provider: "default", id: "UNSET_GATEWAY_PASSWORD" },
    },
    ["fails gateway startup validation", "SecretRef is unresolved"],
  ],
  [
    "allows a resolvable trusted-proxy password SecretRef",
    {
      trustedProxies: ["192.0.2.10"],
      password: { source: "env", provider: "default", id: "SET_GATEWAY_PASSWORD" },
    },
  ],
  [
    // Default doctor must never run exec providers; a run here would throw on the
    // nonexistent command and surface as a startup-failure CRITICAL.
    "skips exec-backed trusted-proxy password SecretRefs without executing them",
    {
      trustedProxies: ["192.0.2.10"],
      password: { source: "exec", provider: "vault", id: "gateway/password" },
      secrets: {
        providers: { vault: { source: "exec", command: "/nonexistent-doctor-exec-probe" } },
      },
    },
    ["Doctor cannot verify", "active exec SecretRef was skipped"],
  ],
  [
    "executes exec-backed trusted-proxy password SecretRefs only when allowed",
    {
      trustedProxies: ["192.0.2.10"],
      password: { source: "exec", provider: "vault", id: "gateway/password" },
      secrets: {
        providers: { vault: { source: "exec", command: "/nonexistent-doctor-exec-probe" } },
      },
      allowExecSecretRefs: true,
    },
    ["fails gateway startup validation", "SecretRef is unresolved (exec:vault:gateway/password)"],
  ],
];

describe("noteSecurityWarnings trusted-proxy boundaries", () => {
  beforeEach(() => {
    note.mockClear();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    vi.stubEnv("SET_GATEWAY_PASSWORD", "proxy-fallback-pass-2f8a");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(trustedProxyBoundaryCases)("%s", async (_name, options, expectedCritical) => {
    const {
      trustedProxies,
      token,
      password,
      trustedProxy,
      controlUi,
      localInterfaces,
      interfaceLookupFails,
      bind,
      customBindHost,
      tailscaleMode,
      secrets,
      allowExecSecretRefs,
    } = options;
    const networkInterfacesSpy = vi.spyOn(os, "networkInterfaces");
    if (interfaceLookupFails) {
      networkInterfacesSpy.mockImplementation(() => {
        throw new Error("synthetic interface lookup failure");
      });
    } else {
      networkInterfacesSpy.mockReturnValue(
        makeNetworkInterfacesSnapshot({
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          ...(localInterfaces
            ? {
                eth0: localInterfaces.map((address) => ({
                  address,
                  family: address.includes(":") ? ("IPv6" as const) : ("IPv4" as const),
                })),
              }
            : {}),
        }),
      );
    }
    try {
      await noteSecurityWarnings(
        {
          secrets,
          gateway: {
            bind: bind ?? "lan",
            customBindHost,
            tailscale: tailscaleMode ? { mode: tailscaleMode } : undefined,
            trustedProxies,
            controlUi: controlUi ?? { allowedOrigins: ["https://control.example.test"] },
            auth: {
              mode: "trusted-proxy",
              token,
              password,
              trustedProxy: trustedProxy ?? { userHeader: "x-forwarded-user" },
            },
          },
        } as OpenClawConfig,
        { allowExecSecretRefs },
      );
    } finally {
      networkInterfacesSpy.mockRestore();
    }

    const message = String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");
    const expectedCriticals = Array.isArray(expectedCritical)
      ? expectedCritical
      : expectedCritical === undefined
        ? []
        : [expectedCritical];
    expect(message.includes("CRITICAL")).toBe(expectedCriticals.length > 0);
    for (const expected of expectedCriticals) {
      expect(message).toContain(expected);
    }
    if (expectedCriticals.length === 0) {
      expect(message).toContain("trusted-proxy authentication configured");
    }
    expect(message).toContain("openclaw security audit --deep");
    expect(message).not.toContain("without authentication");
    expect(message).not.toContain("openclaw doctor --fix");
  });
});
