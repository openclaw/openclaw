import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

  it.each([
    {
      bins: ["node", "jq", "myfilter"],
      warning:
        "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    },
    {
      bins: ["/usr/local/bin/jq", "sed.exe", "myfilter"],
      warning: `- tools.exec.safeBins includes 'sed': ${sedWarning}`,
    },
  ])("scaffolds only custom profiles for $bins", ({ bins, warning }) => {
    const cfg = binConfig(bins);
    if (bins.includes("sed.exe")) {
      expect(scanExecSafeBinCoverage(cfg)).toEqual([
        { scopePath: "tools.exec", bin: "myfilter", kind: "missingProfile", isInterpreter: false },
        riskyHit("jq", jqWarning),
        riskyHit("sed", sedWarning),
      ]);
    }
    expect(maybeRepairExecSafeBinProfiles(cfg)).toEqual({
      config: binConfig(bins, { myfilter: {} }),
      changes: [scaffoldChange],
      warnings: [`- tools.exec.safeBins includes 'jq': ${jqWarning}`, warning],
    });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles(binConfig(["awk", "sed"]));

    expect(result).toEqual({
      config: binConfig(["awk", "sed"]),
      changes: [],
      warnings: [
        "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
        `- tools.exec.safeBins includes 'sed': ${sedWarning}`,
      ],
    });
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = tempDirs.make("openclaw-safe-bin-");
    const binPath = join(tempDir, "custom-safe-bin");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = [tempDir, originalPath].filter((entry) => entry.length > 0).join(delimiter);

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
  });
});
