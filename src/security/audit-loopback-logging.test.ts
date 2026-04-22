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
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "loopback",
            controlUi: { enabled: true },
          },
        };
        expect(
          hasGatewayFinding(
            "gateway.trusted_proxies_missing",
            "info",
            collectGatewayConfigFindings(cfg, cfg, process.env),
          ),
        ).toBe(true);
      })(),
      (async () => {
        // bind="custom" with a loopback customBindHost is accepted as
        // loopback-equivalent by validateGatewayTailscaleBind; the audit
        // check should classify it the same as bind="loopback".
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "custom",
            customBindHost: "127.0.0.1",
            controlUi: { enabled: true },
          },
        };
        expect(
          hasGatewayFinding(
            "gateway.trusted_proxies_missing",
            "info",
            collectGatewayConfigFindings(cfg, cfg, process.env),
          ),
        ).toBe(true);
      })(),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "lan",
            controlUi: { enabled: true },
            auth: { token: "placeholder-for-lan-audit-test" },
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
      (async () => {
        // bind="custom" with a non-loopback customBindHost is not loopback-
        // equivalent and must still surface the warn.
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "custom",
            customBindHost: "192.168.1.10",
            controlUi: { enabled: true },
            auth: { token: "placeholder-for-custom-audit-test" },
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
