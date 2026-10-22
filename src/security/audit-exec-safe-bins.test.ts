// Covers safe-bin audit decisions for exec commands.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type ExecConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>;
function execConfig(global: ExecConfig, agent?: ExecConfig): OpenClawConfig {
  return {
    tools: { exec: global },
    agents: { entries: agent ? { ops: { tools: { exec: agent } } } : { main: {} } },
  };
}

function hasFinding(
  checkId:
    | "tools.exec.safe_bins_interpreter_unprofiled"
    | "tools.exec.safe_bins_broad_behavior"
    | "tools.exec.safe_bin_trusted_dirs_risky",
  findings: SecurityAuditFinding[],
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === "warn");
}

function requireFinding(
  checkId: "tools.exec.safe_bin_trusted_dirs_risky",
  findings: SecurityAuditFinding[],
) {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected ${checkId} finding`);
  }
  return finding;
}

describe("security audit exec safe-bin findings", () => {
  it.each([
    {
      name: "missing profiles",
      cfg: execConfig({ safeBins: ["python3"] }, { safeBins: ["node"] }),
      expected: true,
    },
    {
      name: "profiles configured",
      cfg: execConfig(
        { safeBins: ["python3"], safeBinProfiles: { python3: { maxPositional: 0 } } },
        { safeBins: ["node"], safeBinProfiles: { node: { maxPositional: 0 } } },
      ),
      expected: false,
    },
  ])(
    "warns for interpreter safeBins only when explicit profiles are missing: $name",
    async ({ cfg, expected }) => {
      expect(
        hasFinding(
          "tools.exec.safe_bins_interpreter_unprofiled",
          await collectSecurityAuditFindings(cfg),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: "jq configured globally",
      cfg: execConfig({ safeBins: ["jq"] }),
      expected: true,
    },
    {
      name: "jq not configured",
      cfg: execConfig({ safeBins: ["cut"] }),
      expected: false,
    },
  ])(
    "warns when risky broad-behavior bins are explicitly added to safeBins: $name",
    async ({ cfg, expected }) => {
      expect(
        hasFinding("tools.exec.safe_bins_broad_behavior", await collectSecurityAuditFindings(cfg)),
      ).toBe(expected);
    },
  );

  it("evaluates safeBinTrustedDirs risk findings", async () => {
    const riskyGlobalTrustedDirs =
      process.platform === "win32"
        ? [String.raw`C:\Users\ci-user\bin`, String.raw`C:\Users\ci-user\.local\bin`]
        : ["/usr/local/bin", "/tmp/openclaw-safe-bins"];
    const findings = await collectSecurityAuditFindings(
      execConfig(
        { safeBinTrustedDirs: riskyGlobalTrustedDirs },
        { safeBinTrustedDirs: ["./relative-bin-dir"] },
      ),
    );

    const riskyFinding = requireFinding("tools.exec.safe_bin_trusted_dirs_risky", findings);
    expect(riskyFinding.severity).toBe("warn");
    expect(riskyFinding.detail).toContain(riskyGlobalTrustedDirs[0]);
    expect(riskyFinding.detail).toContain(riskyGlobalTrustedDirs[1]);
    expect(riskyFinding.detail).toContain("agents.entries.ops.tools.exec");
  });

  it("ignores non-risky absolute dirs", async () => {
    expect(
      hasFinding(
        "tools.exec.safe_bin_trusted_dirs_risky",
        await collectSecurityAuditFindings(execConfig({ safeBinTrustedDirs: ["/usr/libexec"] })),
      ),
    ).toBe(false);
  });
});
