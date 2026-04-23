import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectHooksHardeningFindings } from "./audit-extra.sync.js";

function hasFinding(
  findings: ReturnType<typeof collectHooksHardeningFindings>,
  checkId: string,
  severity: "warn" | "critical",
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit hooks ingress findings", () => {
  it("evaluates hooks ingress auth and routing findings", () => {
    const unrestrictedBaseHooks = {
      enabled: true,
      token: "shared-gateway-token-1234567890",
      defaultSessionKey: "hook:ingress",
    } satisfies NonNullable<OpenClawConfig["hooks"]>;
    const requestSessionKeyHooks = {
      ...unrestrictedBaseHooks,
      allowRequestSessionKey: true,
    } satisfies NonNullable<OpenClawConfig["hooks"]>;
    const cases = [
      {
        name: "warns when hooks token looks short",
        cfg: {
          hooks: { enabled: true, token: "short" },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.token_too_short",
        expectedSeverity: "warn" as const,
      },
      {
        name: "flags hooks token reuse of the gateway env token as critical",
        cfg: {
          hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
        } satisfies OpenClawConfig,
        env: {
          OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
        } as NodeJS.ProcessEnv,
        expectedFinding: "hooks.token_reuse_gateway_token",
        expectedSeverity: "critical" as const,
      },
      {
        name: "warns when hooks.defaultSessionKey is unset",
        cfg: {
          hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.default_session_key_unset",
        expectedSeverity: "warn" as const,
      },
      {
        name: "treats wildcard hooks.allowedAgentIds as unrestricted routing",
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
            defaultSessionKey: "hook:ingress",
            allowedAgentIds: ["*"],
          },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "warn" as const,
      },
      {
        name: "scores unrestricted hooks.allowedAgentIds by local exposure",
        cfg: { hooks: unrestrictedBaseHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "warn" as const,
      },
      {
        name: "scores unrestricted hooks.allowedAgentIds by remote exposure",
        cfg: { gateway: { bind: "lan" }, hooks: unrestrictedBaseHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "critical" as const,
      },
      {
        name: "scores hooks request sessionKey override by local exposure",
        cfg: { hooks: requestSessionKeyHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.request_session_key_enabled",
        expectedSeverity: "warn" as const,
        expectedExtraFinding: {
          checkId: "hooks.request_session_key_prefixes_missing",
          severity: "warn" as const,
        },
      },
      {
        name: "scores hooks request sessionKey override by remote exposure",
        cfg: {
          gateway: { bind: "lan" },
          hooks: requestSessionKeyHooks,
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.request_session_key_enabled",
        expectedSeverity: "critical" as const,
      },
    ] as const;

    for (const testCase of cases) {
      const env = "env" in testCase ? testCase.env : process.env;
      const findings = collectHooksHardeningFindings(testCase.cfg, env);
      expect(
        hasFinding(findings, testCase.expectedFinding, testCase.expectedSeverity),
        testCase.name,
      ).toBe(true);
      if ("expectedExtraFinding" in testCase) {
        expect(
          hasFinding(
            findings,
            testCase.expectedExtraFinding.checkId,
            testCase.expectedExtraFinding.severity,
          ),
          testCase.name,
        ).toBe(true);
      }
    }
  });
});
