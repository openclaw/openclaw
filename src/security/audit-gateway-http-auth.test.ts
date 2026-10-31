import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
} from "./audit-extra.sync.js";

const chat = { chatCompletions: { enabled: true } };
const responses = { responses: { enabled: true } };
function config(
  auth: NonNullable<OpenClawConfig["gateway"]>["auth"],
  endpoints: NonNullable<NonNullable<OpenClawConfig["gateway"]>["http"]>["endpoints"] = chat,
  bind: "loopback" | "lan" = "loopback",
): OpenClawConfig {
  return { gateway: { bind, auth, http: { endpoints } } };
}

describe("security audit gateway HTTP auth findings", () => {
  it.each([
    {
      name: "scores loopback gateway HTTP no-auth as warn",
      cfg: config({ mode: "none" }),
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "warn" as const },
      detailIncludes: ["/tools/invoke", "/v1/chat/completions"],
    },
    {
      name: "scores remote gateway HTTP no-auth as critical",
      cfg: {
        ...config({ mode: "none" }, responses, "lan"),
        plugins: { entries: { "admin-http-rpc": { enabled: true } } },
      } satisfies OpenClawConfig,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "critical" as const },
      detailIncludes: ["/api/v1/admin/rpc"],
    },
    {
      name: "does not report gateway.http.no_auth when auth mode is token",
      cfg: config({ mode: "token", token: "secret" }, { ...chat, ...responses }),
      expectedNoFinding: "gateway.http.no_auth",
    },
    {
      name: "does not report gateway.http.no_auth with runtime password auth override",
      cfg: config({ mode: "none" }),
      expectedNoFinding: "gateway.http.no_auth",
      gatewayAuthOverride: {
        mode: "password" as const,
        password: "runtime-gateway-password-1234567890", // pragma: allowlist secret
      },
    },
    {
      name: "reports gateway.http.no_auth when runtime password mode lacks a password",
      cfg: config({ mode: "none" }),
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "warn" as const },
      gatewayAuthOverride: {
        mode: "password" as const,
      },
    },
    {
      name: "reports HTTP API session-key override surfaces when enabled",
      cfg: { gateway: { http: { endpoints: { ...chat, ...responses } } } },
      expectedFinding: {
        checkId: "gateway.http.session_key_override_enabled",
        severity: "info" as const,
      },
      env: process.env,
    },
  ])(
    "$name",
    ({
      cfg,
      expectedFinding,
      expectedNoFinding,
      detailIncludes,
      gatewayAuthOverride,
      env = {},
    }) => {
      const findings = [
        ...collectGatewayHttpNoAuthFindings(cfg, env, { gatewayAuthOverride }),
        ...collectGatewayHttpSessionKeyOverrideFindings(cfg),
      ];

      if (expectedFinding) {
        const finding = findings.find((entry) => entry.checkId === expectedFinding.checkId);
        expect(finding).toMatchObject(expectedFinding);
        if (detailIncludes) {
          for (const text of detailIncludes) {
            expect(finding?.detail, `${expectedFinding.checkId}:${text}`).toContain(text);
          }
        }
      }
      if (expectedNoFinding) {
        expect(findings.map((entry) => entry.checkId)).not.toContain(expectedNoFinding);
      }
    },
  );
});
