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

function tokenConfig(surface: "auth" | "remote", id: string): OpenClawConfig {
  const token = { source: "env" as const, provider: "default", id };
  return {
    secrets: { providers: { default: { source: "env" } } },
    gateway: surface === "auth" ? { auth: { mode: "token", token } } : { remote: { token } },
  };
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
  auth: GatewayProbeResult["auth"] = {
    role: "operator",
    scopes: ["operator.write"],
    capability: "write_capable",
  },
): GatewayProbeResult {
  return {
    ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", error),
    gatewayReached: true,
    connectLatencyMs,
    auth,
  };
}

describe("gateway-status helpers", () => {
  it.each([
    ["SecretRefs", createSecretRefGatewayConfig(), true],
    [
      "empty plaintext",
      {
        gateway: {
          auth: { mode: "token", token: "   ", password: "" },
          remote: { token: " ", password: "" },
        },
      },
      false,
    ],
  ])("summarizes configured credentials for %s", (_name, config, configured) => {
    expect(configSummary(config)).toMatchObject({
      authTokenConfigured: configured,
      authPasswordConfigured: configured,
      remoteTokenConfigured: configured,
      remotePasswordConfigured: configured,
    });
  });
  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync({ REMOTE_GATEWAY_TOKEN: "resolved-remote-token" }, async () => {
      const auth = await resolveAuthForTarget(
        tokenConfig("remote", "REMOTE_GATEWAY_TOKEN"),
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
          tokenConfig("auth", "MISSING_GATEWAY_TOKEN"),
          makeTarget("localLoopback", "ws://127.0.0.1:18789"),
          {},
        );

        expect(auth.diagnostics).toStrictEqual([
          "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
        ]);
      },
    );
  });
  it("treats missing-scope RPC failures as scope-limited and reachable", () => {
    const probe = connectedProbe("missing scope: operator.read", 51);

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toBe(
      "Connect: ok (51ms) · Capability: write-capable · Read check: limited - missing scope: operator.read",
    );
  });

  it("uses structured missing-scope probe details before the display message", () => {
    const probe = {
      ...connectedProbe("permission denied", 51),
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
  it.each([
    [{ mode: "local", tls: { enabled: true } }, undefined, "wss://127.0.0.1:18789"],
    [{ mode: "local", port: 18789 }, 19080, "ws://127.0.0.1:19080"],
  ] as const)("resolves local target %j with port override %s", (gateway, port, url) => {
    const targets = resolveTargets({ gateway }, undefined, port);
    expect(targets.find((target) => target.id === "localLoopback")?.url).toBe(url);
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
  it.each([
    [15_000, "localLoopback", false, "ws://127.0.0.1:18789", 800],
    [500, "localLoopback", false, "ws://127.0.0.1:18789", 500],
    [15_000, "explicit", true, "ws://127.0.0.1:18789", 15_000],
    [2_500, "explicit", true, "wss://localhost:18789/ws", 2_500],
    [15_000, "configRemote", false, "wss://gateway.example/ws", 1500],
    [15_000, "sshTunnel", true, "wss://gateway.example/ws", 2000],
  ] as const)(
    "caps %s ms for %s (active=%s, url=%s) at %s ms",
    (overallMs, kind, active, url, expected) => {
      expect(resolveProbeBudgetMs(overallMs, { kind, active, url })).toBe(expected);
    },
  );

  it("strips a leading ssh command prefix", () => {
    expect(sanitizeSshTarget("ssh me@studio")).toBe("me@studio");
    expect(sanitizeSshTarget("  ssh me@studio:2222  ")).toBe("me@studio:2222");
  });
});
