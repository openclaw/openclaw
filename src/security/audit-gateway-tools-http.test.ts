// Verifies gateway tool HTTP exposure audit findings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";

function hasFinding(
  findings: ReturnType<typeof collectGatewayConfigFindings>,
  checkId: string,
  severity?: "warn" | "critical",
) {
  return findings.some(
    (finding) => finding.checkId === checkId && (severity == null || finding.severity === severity),
  );
}

describe("security audit gateway HTTP tool findings", () => {
  it.each([
    {
      name: "loopback bind",
      cfg: {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["sessions_spawn"] },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn" as const,
    },
    {
      name: "non-loopback bind",
      cfg: {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["sessions_spawn", "gateway"] },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
    },
    {
      name: "newly denied exec override",
      cfg: {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["exec"] },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "critical" as const,
    },
  ])(
    "scores dangerous gateway.tools.allow over HTTP by exposure: $name",
    ({ cfg, expectedSeverity }) => {
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(
        hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow", expectedSeverity),
      ).toBe(true);
    },
  );

  // PR #85664 dual-key gating for the `read` direct-invoke opt-in. The
  // host_read_allow finding only fires when BOTH gates are set; setting
  // either alone leaves `read` unreachable (see tool-resolution.ts) so the
  // finding is silent in those cases.
  describe("host_read_allow finding (dual-key opt-in)", () => {
    it("fires (warn) when both directInvoke.hostFsRead AND allow include read on loopback bind", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: {
            allow: ["read"],
            directInvoke: { hostFsRead: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_read_allow", "warn")).toBe(true);
    });

    it("escalates to critical when bind is lan (extraRisk path)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: {
            allow: ["read"],
            directInvoke: { hostFsRead: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_read_allow", "critical")).toBe(
        true,
      );
    });

    it("does NOT fire when only allow includes read (legacy config; read still default-deny)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["read"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_read_allow")).toBe(false);
    });

    it("does NOT fire when only directInvoke.hostFsRead is true (read still default-deny)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { directInvoke: { hostFsRead: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_read_allow")).toBe(false);
    });

    it("does NOT fire on a vanilla config with no read or hostFsRead", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_read_allow")).toBe(false);
    });
  });
});
