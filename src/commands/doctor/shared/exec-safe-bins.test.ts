// Exec safe-bin tests cover doctor validation of executable helper paths.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveSafeBinProfiles } from "../../../infra/exec-safe-bin-policy.js";
import {
  collectExecSafeBinCoverageInfoNotes,
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
      { scopePath: "tools.exec", bin: "jq", kind: "emptyBuiltinOverride" },
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
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile.",
      "- agents.list.runner.tools.exec.safeBins includes 'jq': jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
    ]);
  });

  it("scaffolds custom safeBin profiles but warns on interpreters", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["node", "myfilter"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- tools.exec.safeBinProfiles.myfilter: added scaffold profile { maxPositional: 0 } (stdin-only default; review and adjust flags/positionals).",
    ]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ myfilter: { maxPositional: 0 } });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["awk", "sed"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes 'sed': sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'awk' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'sed' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("warns on busybox/toybox safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["busybox", "toybox"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'busybox' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'toybox' without profile; remove it from safeBins or use explicit allowlist entries.",
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

      const hits = scanExecSafeBinTrustedDirHints({
        tools: {
          exec: {
            safeBins: ["custom-safe-bin"],
            safeBinProfiles: { "custom-safe-bin": {} },
          },
        },
      } as OpenClawConfig);

      expect(hits).toStrictEqual([
        {
          scopePath: "tools.exec",
          bin: "custom-safe-bin",
          resolvedPath: binPath,
        },
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

describe("doctor exec safe bin built-in profile handling", () => {
  it("reports built-in bins without overrides as info, not missing profiles", () => {
    const cfg = { tools: { exec: { safeBins: ["grep"] } } } as OpenClawConfig;

    const hits = scanExecSafeBinCoverage(cfg);
    expect(hits).toEqual([{ scopePath: "tools.exec", bin: "grep", kind: "builtinProfile" }]);
    expect(collectExecSafeBinCoverageInfoNotes({ hits })).toEqual([
      "- tools.exec.safeBins entry 'grep' uses built-in profile (no custom override needed).",
    ]);
    expect(
      collectExecSafeBinCoverageWarnings({ hits, doctorFixCommand: "openclaw doctor --fix" }),
    ).toStrictEqual([]);

    const repair = maybeRepairExecSafeBinProfiles(cfg);
    expect(repair.changes).toStrictEqual([]);
    expect(repair.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("scaffolds a stdin-only default profile for custom bins", () => {
    const repair = maybeRepairExecSafeBinProfiles({
      tools: { exec: { safeBins: ["myfilter"] } },
    } as OpenClawConfig);

    expect(repair.changes).toEqual([
      "- tools.exec.safeBinProfiles.myfilter: added scaffold profile { maxPositional: 0 } (stdin-only default; review and adjust flags/positionals).",
    ]);
    expect(repair.config.tools?.exec?.safeBinProfiles).toStrictEqual({
      myfilter: { maxPositional: 0 },
    });
  });

  it("warns and removes an empty override that disables a built-in profile", () => {
    const cfg = {
      tools: { exec: { safeBins: ["grep"], safeBinProfiles: { grep: {} } } },
    } as OpenClawConfig;

    const hits = scanExecSafeBinCoverage(cfg);
    expect(hits).toEqual([{ scopePath: "tools.exec", bin: "grep", kind: "emptyBuiltinOverride" }]);
    expect(
      collectExecSafeBinCoverageWarnings({ hits, doctorFixCommand: "openclaw doctor --fix" }),
    ).toEqual([
      "- tools.exec.safeBinProfiles.grep: empty profile overrides built-in defaults (positional limits, allowedValueFlags, and deniedFlags are lost). Remove this entry to restore built-in protection, or provide explicit constraints.",
    ]);

    const repair = maybeRepairExecSafeBinProfiles(cfg);
    expect(repair.changes).toEqual([
      "- tools.exec.safeBinProfiles.grep: removed empty override that disabled the built-in profile (restored built-in positional limits, allowedValueFlags, and deniedFlags).",
    ]);
    expect(repair.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("detects and removes a built-in override that disables profiles via global safeBins fallback", () => {
    // The agent inherits the global safeBins list at runtime, so its empty grep override silently
    // disables the built-in profile even though the agent declares no safeBins of its own.
    const cfg = {
      tools: { exec: { safeBins: ["grep"] } },
      agents: {
        list: [{ id: "ops", tools: { exec: { safeBinProfiles: { grep: {} } } } }],
      },
    } as OpenClawConfig;

    expect(scanExecSafeBinCoverage(cfg)).toEqual([
      { scopePath: "tools.exec", bin: "grep", kind: "builtinProfile" },
      { scopePath: "agents.list.ops.tools.exec", bin: "grep", kind: "emptyBuiltinOverride" },
    ]);

    const repair = maybeRepairExecSafeBinProfiles(cfg);
    expect(repair.changes).toEqual([
      "- agents.list.ops.tools.exec.safeBinProfiles.grep: removed empty override that disabled the built-in profile (restored built-in positional limits, allowedValueFlags, and deniedFlags).",
    ]);
    const ops = repair.config.agents?.list?.find((entry) => entry.id === "ops");
    expect(ops?.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("flags an empty built-in override even when safeBins is not explicitly configured", () => {
    // head is in DEFAULT_SAFE_BINS, so it is an active safeBin at runtime even without an explicit
    // safeBins list; a stale empty override therefore disables its built-in profile.
    const cfg = { tools: { exec: { safeBinProfiles: { head: {} } } } } as OpenClawConfig;

    expect(scanExecSafeBinCoverage(cfg)).toEqual([
      { scopePath: "tools.exec", bin: "head", kind: "emptyBuiltinOverride" },
    ]);

    const repair = maybeRepairExecSafeBinProfiles(cfg);
    expect(repair.changes).toEqual([
      "- tools.exec.safeBinProfiles.head: removed empty override that disabled the built-in profile (restored built-in positional limits, allowedValueFlags, and deniedFlags).",
    ]);
    expect(repair.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("keeps an explicit non-empty override of a built-in bin", () => {
    const cfg = {
      tools: {
        exec: {
          safeBins: ["grep"],
          safeBinProfiles: { grep: { maxPositional: 0, allowedValueFlags: ["-e"] } },
        },
      },
    } as OpenClawConfig;

    expect(scanExecSafeBinCoverage(cfg)).toStrictEqual([]);

    const repair = maybeRepairExecSafeBinProfiles(cfg);
    expect(repair.changes).toStrictEqual([]);
    expect(repair.config.tools?.exec?.safeBinProfiles).toStrictEqual({
      grep: { maxPositional: 0, allowedValueFlags: ["-e"] },
    });
  });

  it("leaves built-in profiles intact through resolveSafeBinProfiles after repair", () => {
    const repair = maybeRepairExecSafeBinProfiles({
      tools: { exec: { safeBins: ["grep"] } },
    } as OpenClawConfig);

    const resolved = resolveSafeBinProfiles(repair.config.tools?.exec?.safeBinProfiles);
    expect(resolved.grep?.maxPositional).toBe(0);
    expect(resolved.grep?.deniedFlags?.size ?? 0).toBeGreaterThan(0);
    expect(resolved.grep?.allowedValueFlags?.size ?? 0).toBeGreaterThan(0);
  });
});
