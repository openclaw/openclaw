import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSecurityAuditCore } from "./audit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());
it.each([
  ["24.16.0", true],
  ["24.22.0", true],
  ["24.22.1", false],
  ["26.1.0", true],
  ["26.12.0", true],
  ["26.12.1", false],
  ["27.0.0-nightly20261018", false],
  ["not-a-version", false],
  ["24.16.0", false, "1.4.4"],
] as const)(
  "audits Node %s security warning=%s (Bun=%s) without deep checks",
  async (version, warning, bun?: string) => {
    vi.stubGlobal(
      "process",
      Object.create(process, {
        versions: { value: { ...process.versions, node: version, bun } },
      }),
    );
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
    const findings = report.findings.filter(
      (finding) => finding.checkId === "runtime.node_security_patch",
    );
    expect(report.summary.warn).toBe(warning ? 1 : 0);
    expect(findings).toHaveLength(warning ? 1 : 0);
    if (warning) {
      expect(findings[0]).toMatchObject({
        severity: "warn",
        detail: expect.stringContaining("Audit process runtime:"),
        remediation: expect.stringContaining("The Gateway may use a different runtime"),
      });
      for (const text of [version, "compromised", "24.22.1", "26.12.1"]) {
        expect(findings[0]?.detail).toContain(text);
      }
    }
  },
);
