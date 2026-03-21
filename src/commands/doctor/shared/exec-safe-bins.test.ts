import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
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

    expect(hits).toEqual([{ scopePath: "tools.exec", bin: "node", isInterpreter: true }]);
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
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ jq: {} });
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-safe-bin-"));
    const binPath = join(tempDir, "custom-safe-bin");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = `${tempDir}:${originalPath}`;

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

    rmSync(tempDir, { recursive: true, force: true });
  });
});
