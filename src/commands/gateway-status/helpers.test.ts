import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  extractConfigSummary,
  isProbeReachable,
  isScopeLimitedProbeFailure,
  renderProbeSummaryLine,
  resolveProbeBudgetMs,
  resolveAuthForTarget,
} from "./helpers.js";

describe("extractConfigSummary", () => {
  it("marks SecretRef-backed gateway auth credentials as configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: {
        secrets: {
          defaults: {
            env: "default",
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
          remote: {
            url: "wss://remote.example:18789",
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      },
    });

    expect(summary.gateway.authTokenConfigured).toBe(true);
    expect(summary.gateway.authPasswordConfigured).toBe(true);
    expect(summary.gateway.remoteTokenConfigured).toBe(true);
    expect(summary.gateway.remotePasswordConfigured).toBe(true);
  });

  it("still treats empty plaintext auth values as not configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "   ",
            password: "",
          },
          remote: {
            token: " ",
            password: "",
          },
        },
      },
    });

    expect(summary.gateway.authTokenConfigured).toBe(false);
    expect(summary.gateway.authPasswordConfigured).toBe(false);
    expect(summary.gateway.remoteTokenConfigured).toBe(false);
    expect(summary.gateway.remotePasswordConfigured).toBe(false);
  });
});

describe("resolveAuthForTarget", () => {
  function createConfigRemoteTarget() {
    return {
      id: "configRemote",
      kind: "configRemote" as const,
      url: "wss://remote.example:18789",
      active: true,
    };
  }

  function createRemoteGatewayTargetConfig(params?: { mode?: "none" | "password" | "token" }) {
    return {
      secrets: {
        providers: {
          default: { source: "env" as const },
        },
      },
      gateway: {
        ...(params?.mode
          ? {
              auth: {
                mode: params.mode,
              },
            }
          : {}),
        remote: {
          token: { source: "env" as const, provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
        },
      },
    };
  }

  it("resolves local auth token SecretRef before probing local targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        LOCAL_GATEWAY_TOKEN: "resolved-local-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                token: { source: "env", provider: "default", id: "LOCAL_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
            active: true,
          },
          {},
        );

        expect(auth).toEqual({ token: "resolved-local-token", password: undefined });
      },
    );
  });

  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig(),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("resolves remote auth even when local auth mode is none", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig({ mode: "none" }),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("does not force remote auth type from local auth mode", async () => {
    const auth = await resolveAuthForTarget(
      {
        gateway: {
          auth: {
            mode: "password",
          },
          remote: {
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      },
      {
        id: "configRemote",
        kind: "configRemote",
        url: "wss://remote.example:18789",
        active: true,
      },
      {},
    );

    expect(auth).toEqual({ token: "remote-token", password: undefined });
  });

  it("redacts resolver internals from unresolved SecretRef diagnostics", async () => {
    await withEnvAsync(
      {
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
            active: true,
          },
          {},
        );

        expect(auth.diagnostics).toContain(
          "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
        );
        expect(auth.diagnostics?.join("\n")).not.toContain("missing or empty");
      },
    );
  });
});

describe("probe reachability classification", () => {
  it("treats missing-scope RPC failures as scope-limited and reachable", () => {
    const probe = {
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toContain("RPC: limited");
  });

  it("keeps non-scope RPC failures as unreachable", () => {
    const probe = {
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 43,
      error: "unknown method: status",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(false);
    expect(isProbeReachable(probe)).toBe(false);
    expect(renderProbeSummaryLine(probe, false)).toContain("RPC: failed");
  });
});

describe("resolveProbeBudgetMs", () => {
  it("gives local loopback probes enough time for detail RPCs", () => {
    expect(resolveProbeBudgetMs(10_000, "localLoopback")).toBe(3000);
    expect(resolveProbeBudgetMs(1200, "localLoopback")).toBe(1200);
    expect(resolveProbeBudgetMs(10_000, "sshTunnel")).toBe(2000);
    expect(resolveProbeBudgetMs(10_000, "explicit")).toBe(1500);
  });
});
