import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
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
const binConfig = (
  safeBins: string[],
  safeBinProfiles?: ExecToolConfig["safeBinProfiles"],
): OpenClawConfig => ({
  tools: { exec: { safeBins, ...(safeBinProfiles ? { safeBinProfiles } : {}) } },
});
afterEach(() => {
  process.env.PATH = originalPath;
});

it("reports scoped interpreter, custom-profile and risky-bin warnings", () => {
  const cfg: OpenClawConfig = {
    ...binConfig(["node", "myfilter"]),
    agents: { entries: { runner: { tools: { exec: { safeBins: ["jq"] } } } } },
  };
  expect(
    collectExecSafeBinCoverageWarnings({
      hits: scanExecSafeBinCoverage(cfg),
      doctorFixCommand: "openclaw doctor --fix",
    }),
  ).toEqual([
    expect.stringMatching(/tools.exec.*interpreter\/runtime 'node' without profile/),
    expect.stringMatching(/tools.exec.*'myfilter'.*missing safeBinProfiles.myfilter/),
    expect.stringMatching(/agents.entries.runner.tools.exec.*'jq'.*environment.*approval-gated/),
    expect.stringContaining('Run "openclaw doctor --fix"'),
  ]);
});

it.each([
  [["node", "jq", "myfilter"], ["jq", "node"], true],
  [["/usr/local/bin/jq", "sed.exe", "myfilter"], ["jq", "sed"], true],
  [["awk", "sed"], ["awk", "sed"], false],
] as const)("scaffolds only custom bins: %j", (bins, warned, scaffold) => {
  const result = maybeRepairExecSafeBinProfiles(binConfig([...bins]));
  expect(result.config).toEqual(binConfig([...bins], scaffold ? { myfilter: {} } : undefined));
  expect(result.changes).toHaveLength(scaffold ? 1 : 0);
  expect(result.warnings).toEqual(
    warned.map((bin) =>
      expect.stringMatching(new RegExp(`'${bin}'.*(?:approval-gated|explicit allowlist)`)),
    ),
  );
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
  expect(collectExecSafeBinTrustedDirHintWarnings(hits)).toStrictEqual([
    `- tools.exec.safeBins entry 'custom-safe-bin' resolves to '${binPath}' outside trusted safe-bin dirs.`,
    "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
  ]);
});
