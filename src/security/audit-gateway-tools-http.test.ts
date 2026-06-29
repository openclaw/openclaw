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

  // PR #85664 [P1] regression: `dangerous_allow` suppression for `read` is
  // source-aware. Suppress ONLY when the `hostFsRead` class opt-in is active
  // (then the more specific `host_read_allow` finding fires instead). Without
  // the opt-in, `allow: ["read"]` still removes `read` from the HTTP deny list,
  // which can make a same-named PLUGIN tool reachable while the built-in stays
  // unmaterialized — so the generic warning MUST fire.
  describe("dangerous_allow source-aware suppression for read", () => {
    it("fires dangerous_allow when only allow:['read'] is set (no hostFsRead opt-in)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["read"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(true);
    });

    it("does NOT fire dangerous_allow when allow:['read'] AND hostFsRead opt-in is set", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["read"], directInvoke: { hostFsRead: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(false);
    });

    it("still fires dangerous_allow when allow includes a non-coding-tool name alongside read", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["read", "sessions_spawn"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow", "warn")).toBe(true);
    });
  });

  // PR #63919: host_write_allow mirrors host_read_allow. Fires only when BOTH
  // `directInvoke.hostFsWrite: true` AND at least one write-class name
  // (`write`/`edit`) is in `allow`. write-class is more dangerous than read so
  // it escalates to critical on any non-loopback bind.
  describe("host_write_allow finding (dual-key opt-in)", () => {
    it("fires (warn) when both directInvoke.hostFsWrite AND allow include write on loopback bind", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: {
            allow: ["write"],
            directInvoke: { hostFsWrite: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow", "warn")).toBe(true);
    });

    it("fires for edit (subset) and escalates to critical when bind is lan", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: {
            allow: ["edit"],
            directInvoke: { hostFsWrite: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow", "critical")).toBe(
        true,
      );
    });

    it("detail names only the allowlisted write-class tool (subset must not claim the sibling is exposed)", () => {
      // clawsweeper #63919 [P1]/[P2]: with only `allow: ["edit"]`, the finding
      // must report `edit` as exposed and NOT also claim the sibling `write`
      // primitive is reachable.
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["edit"], directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      const finding = findings.find(
        (f) => f.checkId === "gateway.tools_invoke_http.host_write_allow",
      );
      expect(finding?.detail).toContain("`edit`");
      expect(finding?.detail).not.toContain("`write`");
    });

    it("does NOT fire when only allow includes write (legacy config; write still default-deny)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["write"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow")).toBe(false);
    });

    it("does NOT fire when only directInvoke.hostFsWrite is true (write still default-deny)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow")).toBe(false);
    });

    it("does NOT fire for apply_patch alone even with hostFsWrite (factory does not produce it)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["apply_patch"], directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow")).toBe(false);
    });
  });

  // PR #63919: `dangerous_allow` suppression for `write`/`edit` is source-aware,
  // mirroring read. Suppress ONLY when the `hostFsWrite` class opt-in is active.
  describe("dangerous_allow source-aware suppression for write", () => {
    it("fires dangerous_allow when only allow:['write'] is set (no hostFsWrite opt-in)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["write"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(true);
    });

    it("does NOT fire dangerous_allow when allow:['write','edit'] AND hostFsWrite opt-in is set", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["write", "edit"], directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(false);
    });

    it("still fires dangerous_allow for apply_patch even with hostFsWrite (never suppressed)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["apply_patch"], directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(true);
    });
  });
});
