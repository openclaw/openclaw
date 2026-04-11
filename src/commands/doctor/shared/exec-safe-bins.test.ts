import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  maybeRepairExecSafeBinProfiles,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./exec-safe-bins.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("doctor exec safe bin helpers", () => {
  it("finds missing safeBin profiles and marks interpreters", () => {
    const hits = scanExecSafeBinCoverage({
      tools: {
        exec: {
          safeBins: ["node", "jq"],
          safeBinProfiles: { jq: {} },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      { scopePath: "tools.exec", bin: "node", kind: "missingProfile", isInterpreter: true },
      {
        scopePath: "tools.exec",
        bin: "jq",
        kind: "riskySemantics",
        warning:
          "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
    ]);
  });

  it("formats coverage warnings", () => {
    const warnings = collectExecSafeBinCoverageWarnings({
      hits: [
        { scopePath: "tools.exec", bin: "node", kind: "missingProfile", isInterpreter: true },
        {
          scopePath: "agents.list.runner.tools.exec",
          bin: "jq",
          kind: "riskySemantics",
          warning:
            "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("tools.exec.safeBins includes interpreter/runtime 'node'"),
      expect.stringContaining("agents.list.runner.tools.exec.safeBins includes 'jq'"),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });

  it("scaffolds custom safeBin profiles but warns on interpreters", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["node", "jq"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- tools.exec.safeBinProfiles.jq: added scaffold profile {} (review and tighten flags/positionals).",
    ]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'jq': jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ jq: {} });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["awk", "sed"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes 'sed': sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'awk' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'sed' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({});
  });

  it("rejects cat/ls safeBins instead of scaffolding profiles", () => {
    const hits = scanExecSafeBinCoverage({
      tools: {
        exec: {
          safeBins: ["cat", "ls"],
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        scopePath: "tools.exec",
        bin: "cat",
        kind: "riskySemantics",
        warning:
          "cat reads named files by design, so do not treat it as a stdin-only safeBin; use an explicit executable-path allowlist entry or approval-gated run instead.",
      },
      {
        scopePath: "tools.exec",
        bin: "ls",
        kind: "riskySemantics",
        warning:
          "ls enumerates filesystem paths by design, so do not treat it as a stdin-only safeBin; use an explicit executable-path allowlist entry or approval-gated run instead.",
      },
    ]);

    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["cat", "ls"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'cat': remove it from safeBins and use an explicit executable-path allowlist entry or approval-gated run instead.",
      "- tools.exec.safeBins includes 'ls': remove it from safeBins and use an explicit executable-path allowlist entry or approval-gated run instead.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({});
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-safe-bin-"));
    const binPath = join(tempDir, "custom-safe-bin");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = [tempDir, originalPath].filter((entry) => entry.length > 0).join(delimiter);

    const hits = scanExecSafeBinTrustedDirHints({
      tools: {
        exec: {
          safeBins: ["custom-safe-bin"],
          safeBinProfiles: { "custom-safe-bin": {} },
        },
      },
    } as OpenClawConfig);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      scopePath: "tools.exec",
      bin: "custom-safe-bin",
      resolvedPath: binPath,
    });

    expect(collectExecSafeBinTrustedDirHintWarnings(hits)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tools.exec.safeBins entry 'custom-safe-bin'"),
        expect.stringContaining("tools.exec.safeBinTrustedDirs"),
      ]),
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("steers mutable trusted-dir candidates to explicit allowlist entries", () => {
    const warnings = collectExecSafeBinTrustedDirHintWarnings([
      {
        scopePath: "tools.exec",
        bin: "python3",
        resolvedPath: "/home/test/.nvm/versions/node/v22/bin/python3",
      },
    ]);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("outside trusted safe-bin dirs"),
        expect.stringContaining("explicit executable-path allowlist entry"),
      ]),
    );
  });

  it("still hints safeBinTrustedDirs for non-mutable immutable directories", () => {
    const warnings = collectExecSafeBinTrustedDirHintWarnings([
      {
        scopePath: "tools.exec",
        bin: "custom-safe-bin",
        resolvedPath: "/usr/libexec/custom-safe-bin",
      },
    ]);

    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("tools.exec.safeBinTrustedDirs")]),
    );
  });
});
