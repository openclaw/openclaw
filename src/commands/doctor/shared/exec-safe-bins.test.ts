import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ExecToolConfig } from "../../../config/types.tools.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  maybeRepairExecSafeBinProfiles,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./exec-safe-bins.js";

const originalPath = process.env.PATH ?? "";
const jqWarning =
  "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.";
const sedWarning =
  "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.";
const scaffoldChange =
  "- tools.exec.safeBinProfiles.myfilter: added scaffold profile {} (review and tighten flags/positionals).";

function binConfig(
  safeBins: string[],
  safeBinProfiles?: ExecToolConfig["safeBinProfiles"],
): OpenClawConfig {
  return { tools: { exec: { safeBins, ...(safeBinProfiles ? { safeBinProfiles } : {}) } } };
}

function riskyHit(bin: string, warning: string, scopePath = "tools.exec") {
  return { scopePath, bin, kind: "riskySemantics" as const, warning };
}

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("doctor exec safe bin helpers", () => {
  it("formats coverage warnings", () => {
    const warnings = collectExecSafeBinCoverageWarnings({
      hits: [
        { scopePath: "tools.exec", bin: "node", kind: "missingProfile", isInterpreter: true },
        riskyHit("jq", jqWarning, "agents.list.runner.tools.exec"),
        { scopePath: "tools.exec", bin: "myfilter", kind: "missingProfile", isInterpreter: false },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile.",
      "- tools.exec.safeBins entry 'myfilter' is missing safeBinProfiles.myfilter.",
      `- agents.list.runner.tools.exec.safeBins includes 'jq': ${jqWarning}`,
      '- Run "openclaw doctor --fix" to scaffold missing custom safeBinProfiles entries.',
    ]);
  });

  it("scaffolds custom safeBin profiles but warns on interpreters and risky bins", () => {
    const result = maybeRepairExecSafeBinProfiles(binConfig(["node", "jq", "myfilter"]));

    expect(result.changes).toEqual([scaffoldChange]);
    expect(result.warnings).toEqual([
      `- tools.exec.safeBins includes 'jq': ${jqWarning}`,
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ myfilter: {} });
  });

  it("does not scaffold normalized risky safeBins from path-like entries", () => {
    const cfg = binConfig(["/usr/local/bin/jq", "sed.exe", "myfilter"]);
    const hits = scanExecSafeBinCoverage(cfg);

    expect(hits).toEqual([
      { scopePath: "tools.exec", bin: "myfilter", kind: "missingProfile", isInterpreter: false },
      riskyHit("jq", jqWarning),
      riskyHit("sed", sedWarning),
    ]);

    const result = maybeRepairExecSafeBinProfiles(cfg);

    expect(result.changes).toEqual([scaffoldChange]);
    expect(result.warnings).toEqual([
      `- tools.exec.safeBins includes 'jq': ${jqWarning}`,
      `- tools.exec.safeBins includes 'sed': ${sedWarning}`,
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ myfilter: {} });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles(binConfig(["awk", "sed"]));

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      `- tools.exec.safeBins includes 'sed': ${sedWarning}`,
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-safe-bin-"));
    try {
      const binPath = join(tempDir, "custom-safe-bin");
      writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binPath, 0o755);
      process.env.PATH = [tempDir, originalPath]
        .filter((entry) => entry.length > 0)
        .join(delimiter);

      const hits = scanExecSafeBinTrustedDirHints(
        binConfig(["custom-safe-bin"], { "custom-safe-bin": {} }),
      );

      expect(hits).toStrictEqual([
        { scopePath: "tools.exec", bin: "custom-safe-bin", resolvedPath: binPath },
      ]);

      const warnings = collectExecSafeBinTrustedDirHintWarnings(hits);
      expect(warnings).toStrictEqual([
        `- tools.exec.safeBins entry 'custom-safe-bin' resolves to '${binPath}' outside trusted safe-bin dirs.`,
        "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
