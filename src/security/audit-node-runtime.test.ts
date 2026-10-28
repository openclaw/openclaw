import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSecurityAuditCore } from "./audit.js";

describe("security audit process Node security patches", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const nodeVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  const bunVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");

  afterEach(() => {
    if (nodeVersionDescriptor) {
      Object.defineProperty(process.versions, "node", nodeVersionDescriptor);
    }
    if (bunVersionDescriptor) {
      Object.defineProperty(process.versions, "bun", bunVersionDescriptor);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
  });

  async function audit(version: string, bun?: string) {
    Object.defineProperty(process.versions, "node", { value: version, configurable: true });
    if (bun) {
      Object.defineProperty(process.versions, "bun", { value: bun, configurable: true });
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    const rootDir = tempDirs.make("openclaw-audit-node-runtime-");
    const probeGatewayFn = vi.fn();
    const report = await runSecurityAuditCore({
      config: {
        agents: { entries: { main: {} } },
        gateway: {
          controlUi: { enabled: false },
          auth: { mode: "token", token: "audit-node-runtime-token-long-enough" },
        },
        tools: { exec: { security: "deny" } },
      },
      env: { HOME: rootDir, OPENCLAW_STATE_DIR: rootDir },
      stateDir: rootDir,
      configPath: path.join(rootDir, "openclaw.json"),
      workspaceDir: rootDir,
      includeFilesystem: false,
      plugins: [],
      loadPluginSecurityCollectors: false,
      probeGatewayFn,
    });
    expect(probeGatewayFn).not.toHaveBeenCalled();
    expect(report.deep).toBeUndefined();
    return report;
  }

  it.each([
    { version: "24.16.0", warning: true },
    { version: "24.22.0", warning: true },
    { version: "24.22.1", warning: false },
    { version: "26.1.0", warning: true },
    { version: "26.12.0", warning: true },
    { version: "26.12.1", warning: false },
  ])(
    "reports warning=$warning for Node $version without deep checks",
    async ({ version, warning }) => {
      const report = await audit(version);
      const findings = report.findings.filter(
        (finding) => finding.checkId === "runtime.node_security_patch",
      );
      expect(report.summary.warn).toBe(warning ? 1 : 0);
      if (warning) {
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          severity: "warn",
          detail: expect.stringContaining("Audit process runtime:"),
          remediation: expect.stringContaining("The Gateway may use a different runtime"),
        });
        expect(findings[0]?.detail).toContain(version);
      } else {
        expect(findings).toEqual([]);
      }
    },
  );

  it("does not warn for Bun based on its Node compatibility version", async () => {
    const report = await audit("24.16.0", "1.4.4");
    expect(report.findings).not.toContainEqual(
      expect.objectContaining({ checkId: "runtime.node_security_patch" }),
    );
    expect(report.summary.warn).toBe(0);
  });
});
