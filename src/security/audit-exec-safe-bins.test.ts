import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

type ExecConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>;
function execConfig(global: ExecConfig, agent?: ExecConfig): OpenClawConfig {
  return {
    tools: { exec: global },
    agents: { entries: agent ? { ops: { tools: { exec: agent } } } : { main: {} } },
  };
}

async function findWarning(suffix: string, global: ExecConfig, agent?: ExecConfig) {
  const findings = await collectSecurityAuditFindings(execConfig(global, agent));
  return findings.find((f) => f.checkId === `tools.exec.${suffix}` && f.severity === "warn");
}

describe("security audit exec safe-bin findings", () => {
  it.each([
    ["missing profiles", false],
    ["profiles configured", true],
  ] as const)("checks interpreter profiles: %s", async (_name, profiled) => {
    const bin = (name: string): ExecConfig => ({
      safeBins: [name],
      ...(profiled ? { safeBinProfiles: { [name]: { maxPositional: 0 } } } : {}),
    });
    expect(
      Boolean(await findWarning("safe_bins_interpreter_unprofiled", bin("python3"), bin("node"))),
    ).toBe(!profiled);
  });

  it.each([
    ["jq", true],
    ["cut", false],
  ] as const)("checks broad-behavior bin %s", async (bin, expected) => {
    expect(Boolean(await findWarning("safe_bins_broad_behavior", { safeBins: [bin] }))).toBe(
      expected,
    );
  });

  it("evaluates safeBinTrustedDirs risk findings", async () => {
    const riskyGlobalTrustedDirs =
      process.platform === "win32"
        ? [String.raw`C:\Users\ci-user\bin`, String.raw`C:\Users\ci-user\.local\bin`]
        : ["/usr/local/bin", "/tmp/openclaw-safe-bins"];
    const finding = await findWarning(
      "safe_bin_trusted_dirs_risky",
      { safeBinTrustedDirs: riskyGlobalTrustedDirs },
      { safeBinTrustedDirs: ["./relative-bin-dir"] },
    );
    expect(finding).toBeDefined();
    for (const detail of [...riskyGlobalTrustedDirs, "agents.entries.ops.tools.exec"]) {
      expect(finding?.detail).toContain(detail);
    }
  });

  it("ignores non-risky absolute dirs", async () => {
    expect(
      await findWarning("safe_bin_trusted_dirs_risky", { safeBinTrustedDirs: ["/usr/libexec"] }),
    ).toBeUndefined();
  });
});
