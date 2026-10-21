import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

const remote = (auth: { token?: string; password?: string }) => ({
  url: "wss://remote.example.com:18789",
  ...auth,
});

describe("security audit gateway auth selection", () => {
  it("applies gateway auth precedence across local and remote modes", () => {
    const cases: Array<{
      name: string;
      gateway: OpenClawConfig["gateway"];
      env?: NodeJS.ProcessEnv;
      expectedAuth: { token?: string; password?: string };
    }> = [
      {
        name: "uses local auth when gateway.mode is local",
        gateway: { mode: "local", auth: { token: "local-token-abc123" } },
        expectedAuth: { token: "local-token-abc123" },
      },
      {
        name: "prefers local config token over env token",
        gateway: { mode: "local", auth: { token: "local-token" } },
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        expectedAuth: { token: "local-token" },
      },
      {
        name: "uses local auth when gateway.mode is undefined (default)",
        gateway: { auth: { token: "default-local-token" } },
        expectedAuth: { token: "default-local-token" },
      },
      {
        name: "uses remote auth when gateway.mode is remote with URL",
        gateway: {
          mode: "remote",
          auth: { token: "local-token-should-not-use" },
          remote: remote({ token: "remote-token-xyz789" }),
        },
        expectedAuth: { token: "remote-token-xyz789" },
      },
      {
        name: "ignores env token when gateway.mode is remote",
        gateway: {
          mode: "remote",
          auth: { token: "local-token-should-not-use" },
          remote: remote({ token: "remote-token" }),
        },
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        expectedAuth: { token: "remote-token" },
      },
      {
        name: "falls back to local auth when gateway.mode is remote but URL is missing",
        gateway: {
          mode: "remote",
          auth: { token: "fallback-local-token" },
          remote: { token: "remote-token-should-not-use" },
        },
        expectedAuth: { token: "fallback-local-token" },
      },
      {
        name: "uses remote password when env is unset",
        gateway: { mode: "remote", remote: remote({ password: "remote-pass" }) },
        expectedAuth: { password: "remote-pass" },
      },
      {
        name: "prefers env password over remote password",
        gateway: { mode: "remote", remote: remote({ password: "remote-pass" }) },
        env: { OPENCLAW_GATEWAY_PASSWORD: "env-pass" },
        expectedAuth: { password: "env-pass" },
      },
    ];

    for (const { name, gateway, env = {}, expectedAuth } of cases) {
      const cfg = { gateway };
      const result = resolveGatewayProbeAuthSafe({
        cfg,
        env,
        mode: resolveGatewayProbeTarget(cfg).mode,
      });
      expect(result.auth, name).toEqual(expectedAuth);
    }
  });

  it("adds warning finding when probe auth SecretRef is unavailable", () => {
    const token = { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" } as const;
    const cfg: OpenClawConfig = {
      gateway: { mode: "local", auth: { mode: "token", token } },
      secrets: { providers: { default: { source: "env" } } },
    };

    const result = resolveGatewayProbeAuthSafe({
      cfg,
      mode: "local",
      env: {},
    });
    const findings = collectDeepProbeFindings({
      deep: {
        gateway: {
          attempted: true,
          url: "ws://127.0.0.1:18789",
          ok: true,
          error: null,
          close: null,
        },
      },
      authWarning: result.warning,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        detail: expect.stringContaining("gateway.auth.token"),
      }),
    );
  });
});
