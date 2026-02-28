import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectLocalModelSecurityFindings } from "./audit-local-model.js";

describe("collectLocalModelSecurityFindings", () => {
  it("returns no findings when mode is off", () => {
    const cfg: OpenClawConfig = {};
    const findings = collectLocalModelSecurityFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings when mode is explicitly off", () => {
    const cfg: OpenClawConfig = { localModelSecurity: { mode: "off" } };
    const findings = collectLocalModelSecurityFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("warns when mode is audit-only", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "audit",
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const auditFinding = findings.find((f) => f.checkId === "local-model-audit-only");
    expect(auditFinding).toBeDefined();
    expect(auditFinding!.severity).toBe("warn");
  });

  it("warns when no local providers are configured", () => {
    const cfg: OpenClawConfig = { localModelSecurity: { mode: "enforced" } };
    const findings = collectLocalModelSecurityFindings(cfg);
    const noProviders = findings.find((f) => f.checkId === "local-model-no-providers");
    expect(noProviders).toBeDefined();
    expect(noProviders!.severity).toBe("warn");
  });

  it("flags non-local provider URLs as critical", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [
          { type: "ollama", baseUrl: "https://api.external-cloud.com:11434", name: "bad" },
        ],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const nonLocal = findings.find((f) => f.checkId === "local-model-nonlocal-provider");
    expect(nonLocal).toBeDefined();
    expect(nonLocal!.severity).toBe("critical");
    expect(nonLocal!.title).toContain("bad");
  });

  it("flags cloud providers not blocked in enforced mode", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        blockCloudProviders: false,
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const cloudNotBlocked = findings.find((f) => f.checkId === "local-model-cloud-not-blocked");
    expect(cloudNotBlocked).toBeDefined();
    expect(cloudNotBlocked!.severity).toBe("critical");
  });

  it("flags web access not blocked in enforced mode", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        blockWebAccess: false,
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const webNotBlocked = findings.find((f) => f.checkId === "local-model-web-not-blocked");
    expect(webNotBlocked).toBeDefined();
    expect(webNotBlocked!.severity).toBe("warn");
  });

  it("reports info when telemetry not blocked", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        blockTelemetry: false,
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const telemetry = findings.find((f) => f.checkId === "local-model-telemetry-not-blocked");
    expect(telemetry).toBeDefined();
    expect(telemetry!.severity).toBe("info");
  });

  it("flags HTTP provider when TLS is required", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        requireTls: true,
        localProviders: [
          {
            type: "ollama",
            baseUrl: "http://192.168.1.100:11434",
            requireTls: true,
            name: "lan-ollama",
          },
        ],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const noTls = findings.find((f) => f.checkId === "local-model-no-tls");
    expect(noTls).toBeDefined();
    expect(noTls!.severity).toBe("warn");
    expect(noTls!.title).toContain("lan-ollama");
  });

  it("does not flag loopback HTTP when TLS is required", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        requireTls: true,
        localProviders: [
          {
            type: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            requireTls: true,
          },
        ],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const noTls = findings.find((f) => f.checkId === "local-model-no-tls");
    expect(noTls).toBeUndefined();
  });

  it("reports info when no egress policy is configured", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const noEgress = findings.find((f) => f.checkId === "local-model-no-egress-policy");
    expect(noEgress).toBeDefined();
    expect(noEgress!.severity).toBe("info");
  });

  it("reports existing cloud providers that would be blocked", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", models: [] },
          anthropic: { baseUrl: "https://api.anthropic.com/v1", models: [] },
          "local-ollama": { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] },
        },
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const existing = findings.find((f) => f.checkId === "local-model-existing-cloud-providers");
    expect(existing).toBeDefined();
    expect(existing!.detail).toContain("openai");
    expect(existing!.detail).toContain("anthropic");
  });

  it("has no critical findings for a well-configured local-only setup", () => {
    const cfg: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        blockCloudProviders: true,
        blockWebAccess: true,
        blockTelemetry: true,
        networkEgress: {
          blockExternalRequests: true,
          allowedHosts: [{ host: "192.168.1.100", port: 11434, label: "Ollama server" }],
        },
        localProviders: [
          { type: "ollama", baseUrl: "http://192.168.1.100:11434", name: "corp-ollama" },
        ],
      },
    };
    const findings = collectLocalModelSecurityFindings(cfg);
    const criticals = findings.filter((f) => f.severity === "critical");
    expect(criticals).toHaveLength(0);
  });
});
