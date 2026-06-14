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

  // `dangerous_allow` suppression is source-aware: only suppress for
  // `read`/`write`/`edit` when the matching class opt-in is active. Without it,
  // `allow` removes those names from the HTTP deny list and a same-named plugin
  // could be reachable — so the generic warning must fire.
  describe("dangerous_allow source-aware suppression for coding-tool names", () => {
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

    it("fires dangerous_allow when only allow:['write','edit'] is set (no hostFsWrite opt-in)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: { allow: ["write", "edit"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(true);
    });

    it("does NOT fire dangerous_allow when allow:['write','edit'] AND hostFsWrite opt-in is set", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["write", "edit"], directInvoke: { hostFsWrite: true } },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow")).toBe(false);
    });

    it("still fires dangerous_allow when allow includes a non-coding-tool name alongside read/write", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: { allow: ["read", "write", "sessions_spawn"] },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.dangerous_allow", "warn")).toBe(true);
    });
  });

  // PR #63919 dual-key gating for the write-class direct-invoke opt-in
  // (`write`, `edit`, `apply_patch`). Same pattern as hostFsRead.
  describe("host_write_allow finding (dual-key opt-in)", () => {
    it("fires (warn) when both hostFsWrite AND allow include write on loopback bind", () => {
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

    it("fires for edit and apply_patch in allow when hostFsWrite true", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: {
            allow: ["edit", "apply_patch"],
            directInvoke: { hostFsWrite: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow", "warn")).toBe(true);
    });

    it("escalates to critical when bind is lan", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          auth: { token: "secret" },
          tools: {
            allow: ["write"],
            directInvoke: { hostFsWrite: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow", "critical")).toBe(
        true,
      );
    });

    it("does NOT fire when only allow includes write (legacy shape — write still default-deny)", () => {
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

    it("does NOT fire when only hostFsWrite is true (no write tools in allow)", () => {
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

    it("does NOT fire when hostFsWrite true but allow only includes read (different class)", () => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { token: "secret" },
          tools: {
            allow: ["read"],
            directInvoke: { hostFsWrite: true },
          },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFinding(findings, "gateway.tools_invoke_http.host_write_allow")).toBe(false);
    });
  });
});
