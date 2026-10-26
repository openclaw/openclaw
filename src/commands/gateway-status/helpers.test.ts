import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  extractConfigSummary,
  isProbeReachable,
  isPostConnectProbeFailure,
  isScopeLimitedProbeFailure,
  renderProbeSummaryLine,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
  resolveTargets,
  sanitizeSshTarget,
  type GatewayStatusTarget,
} from "./helpers.js";
import { createUnreachableGatewayProbe, createSecretRefGatewayConfig } from "./test-support.js";

function makeTarget(kind: GatewayStatusTarget["kind"], url: string): GatewayStatusTarget {
  return { id: kind, kind, url, active: true };
}

function configSummary(config: unknown) {
  return extractConfigSummary({
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    issues: [],
    legacyIssues: [],
    config,
  }).gateway;
}

function connectedProbe(
  error: string,
  connectLatencyMs: number,
  auth: GatewayProbeResult["auth"],
): GatewayProbeResult {
  return {
    ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", error),
    gatewayReached: true,
    connectLatencyMs,
    auth,
  };
}

describe("extractConfigSummary", () => {
  it("marks SecretRef-backed gateway auth credentials as configured", () => {
    expect(configSummary(createSecretRefGatewayConfig())).toMatchObject({
      authTokenConfigured: true,
      authPasswordConfigured: true,
      remoteTokenConfigured: true,
      remotePasswordConfigured: true,
    });
  });

  it("still treats empty plaintext auth values as not configured", () => {
    expect(
      configSummary({
        gateway: {
          auth: { mode: "token", token: "   ", password: "" },
          remote: { token: " ", password: "" },
        },
      }),
    ).toMatchObject({
      authTokenConfigured: false,
      authPasswordConfigured: false,
      remoteTokenConfigured: false,
      remotePasswordConfigured: false,
    });
  });
});

describe("resolveAuthForTarget", () => {
  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync({ REMOTE_GATEWAY_TOKEN: "resolved-remote-token" }, async () => {
      const auth = await resolveAuthForTarget(
        {
          secrets: { providers: { default: { source: "env" } } },
          gateway: {
            remote: {
              token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            },
          },
        },
        makeTarget("configRemote", "wss://remote.example:18789"),
        {},
      );

      expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
    });
  });

  it("redacts resolver internals from unresolved SecretRef diagnostics", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: { providers: { default: { source: "env" } } },
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
              },
            },
          },
          makeTarget("localLoopback", "ws://127.0.0.1:18789"),
          {},
        );

        expect(auth.diagnostics).toStrictEqual([
          "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
        ]);
      },
    );
  });
});

describe("probe reachability classification", () => {
  it("treats missing-scope RPC failures as scope-limited and reachable", () => {
    const probe = connectedProbe("missing scope: operator.read", 51, {
      role: "operator",
      scopes: ["operator.write"],
      capability: "write_capable",
    });

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toBe(
      "Connect: ok (51ms) · Capability: write-capable · Read check: limited - missing scope: operator.read",
    );
  });

  it("uses structured missing-scope probe details before the display message", () => {
    const probe = {
      ...connectedProbe("permission denied", 51, {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      }),
      missingScopeErrorDetails: {
        code: "MISSING_SCOPE" as const,
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
  });

  it("treats post-connect read failures as reachable with failed diagnostics", () => {
    const probe = connectedProbe("unknown method: status", 43, {
      role: "operator",
      scopes: [],
      capability: "connected_no_operator_scope",
    });

    expect(isScopeLimitedProbeFailure(probe)).toBe(false);
    expect(isPostConnectProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toBe(
      "Connect: ok (43ms) · Capability: connect-only · Read check: failed - unknown method: status",
    );
  });

  it("keeps failed-before-connect probes unreachable", () => {
    const probe = createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout");

    expect(isPostConnectProbeFailure(probe)).toBe(false);
    expect(isProbeReachable(probe)).toBe(false);
  });
});
describe("gateway-status local target scheme", () => {
  it("uses wss for local loopback targets when gateway TLS is enabled", () => {
    const cfg: OpenClawConfig = { gateway: { mode: "local", tls: { enabled: true } } };

    const targets = resolveTargets(cfg);
    const localLoopbackTarget = targets.find((target) => target.id === "localLoopback");
    expect(localLoopbackTarget?.url).toBe("wss://127.0.0.1:18789");
  });

  it("uses a local port override for loopback targets", () => {
    const cfg: OpenClawConfig = { gateway: { mode: "local", port: 18789 } };

    const targets = resolveTargets(cfg, undefined, 19080);
    const localLoopbackTarget = targets.find((target) => target.id === "localLoopback");
    expect(localLoopbackTarget?.url).toBe("ws://127.0.0.1:19080");
  });

  it("preserves explicit URL targets when a local port override is also present", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "remote",
        port: 18789,
        remote: { url: "wss://remote.example:18789" },
      },
    };

    expect(resolveTargets(cfg, "wss://override.example/ws", 19080)).toEqual([
      makeTarget("explicit", "wss://override.example/ws"),
      makeTarget("configRemote", "wss://remote.example:18789"),
      makeTarget("localLoopback", "ws://127.0.0.1:19080"),
    ]);
  });
});

describe("resolveProbeBudgetMs", () => {
  it.each([
    [
      "keeps inactive local loopback probes on the short cap",
      [
        [15_000, "localLoopback", false, "ws://127.0.0.1:18789", 800],
        [500, "localLoopback", false, "ws://127.0.0.1:18789", 500],
      ],
    ],
    [
      "lets explicit loopback URLs use the full caller budget",
      [
        [15_000, "explicit", true, "ws://127.0.0.1:18789", 15_000],
        [2_500, "explicit", true, "wss://localhost:18789/ws", 2_500],
      ],
    ],
    [
      "keeps inactive remote and SSH tunnel probes on the short cap",
      [
        [15_000, "configRemote", false, "wss://gateway.example/ws", 1500],
        [15_000, "sshTunnel", true, "wss://gateway.example/ws", 2000],
      ],
    ],
  ] as const)("%s", (_name, cases) => {
    for (const [overallMs, kind, active, url, expected] of cases) {
      expect(resolveProbeBudgetMs(overallMs, { kind, active, url })).toBe(expected);
    }
  });
});

describe("sanitizeSshTarget", () => {
  it("strips a leading ssh command prefix", () => {
    expect(sanitizeSshTarget("ssh me@studio")).toBe("me@studio");
    expect(sanitizeSshTarget("  ssh me@studio:2222  ")).toBe("me@studio:2222");
  });
});
