import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { collectGatewayConfigFindings, collectLoggingFindings } from "./audit.js";

function hasGatewayFinding(
  checkId: "gateway.trusted_proxies_missing" | "gateway.loopback_no_auth",
  severity: "info" | "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function hasLoggingFinding(
  checkId: "logging.redact_off",
  severity: "warn",
  findings: ReturnType<typeof collectLoggingFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit loopback and logging findings", () => {
  it("evaluates loopback control UI and logging exposure findings", async () => {
    await Promise.all([
      (async () => {
        // Regression for #70357: loopback bind downgrades the missing-
        // trusted-proxies finding to `info` because X-Forwarded-For
        // spoofing requires local-host access, so the risk is latent.
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "loopback",
            controlUi: { enabled: true },
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, process.env);
        expect(
          hasGatewayFinding("gateway.trusted_proxies_missing", "info", findings),
        ).toBe(true);
        expect(
          hasGatewayFinding("gateway.trusted_proxies_missing", "warn", findings),
        ).toBe(false);
      })(),
      (async () => {
        // Non-loopback bind keeps warn — off-host exposure makes the
        // missing allowlist an active spoofing risk.
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "lan",
            controlUi: { enabled: true },
          },
        };
        expect(
          hasGatewayFinding(
            "gateway.trusted_proxies_missing",
            "warn",
            collectGatewayConfigFindings(cfg, cfg, process.env),
          ),
        ).toBe(true);
      })(),
      withEnvAsync(
        {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
        },
        async () => {
          const cfg: OpenClawConfig = {
            gateway: {
              bind: "loopback",
              controlUi: { enabled: true },
              auth: {},
            },
          };
          expect(
            hasGatewayFinding(
              "gateway.loopback_no_auth",
              "critical",
              collectGatewayConfigFindings(cfg, cfg, process.env),
            ),
          ).toBe(true);
        },
      ),
      (async () => {
        const cfg: OpenClawConfig = {
          logging: { redactSensitive: "off" },
        };
        expect(hasLoggingFinding("logging.redact_off", "warn", collectLoggingFindings(cfg))).toBe(
          true,
        );
      })(),
    ]);
  });
});
