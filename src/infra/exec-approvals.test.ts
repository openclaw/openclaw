// Covers exec approval allowlist evaluation.
import { describe, expect, it } from "vitest";
import { normalizeSafeBins } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { evaluateExecAllowlist } from "./exec-approvals.js";

function segment(
  argv: [string, ...string[]],
  paths: { resolvedPath?: string; resolvedRealPath?: string; executableName?: string } = {},
) {
  return {
    raw: argv.join(" "),
    argv,
    resolution: makeMockCommandResolution({
      execution: makeMockExecutableResolution({
        rawExecutable: argv[0],
        executableName: argv[0],
        ...paths,
      }),
    }),
  };
}

function toolSegment() {
  return segment(["tool"], { resolvedPath: "/usr/bin/tool" });
}

function headSegment() {
  return segment(["head", "-n", "1"], {
    resolvedPath: "/usr/bin/head",
    resolvedRealPath: "/usr/bin/head",
  });
}

function evaluateAutoAllowSkills(command: ReturnType<typeof segment>, resolvedPath: string) {
  return evaluateExecAllowlist({
    analysis: { ok: true, segments: [command] },
    allowlist: [],
    safeBins: new Set(),
    skillBins: [{ name: "skill-bin", resolvedPath }],
    autoAllowSkills: true,
    cwd: "/tmp",
  });
}

function expectAutoAllowSkillsMiss(result: ReturnType<typeof evaluateExecAllowlist>): void {
  expect(result.allowlistSatisfied).toBe(false);
  expect(result.segmentSatisfiedBy).toEqual([null]);
}

describe("exec approvals allowlist evaluation", () => {
  it("satisfies allowlist on exact match", () => {
    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [toolSegment()] },
      allowlist: [{ pattern: "/usr/bin/tool" }],
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
  });

  it("satisfies allowlist via safe bins", () => {
    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [headSegment()] },
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      cwd: "/tmp",
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches).toStrictEqual([]);
  });

  it("satisfies allowlist via auto-allow skills", () => {
    const result = evaluateAutoAllowSkills(
      segment(["skill-bin", "--help"], { resolvedPath: "/opt/skills/skill-bin" }),
      "/opt/skills/skill-bin",
    );
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("matches auto-allow skill bins against the executable trust realpath", () => {
    const command = segment(["skill-bin", "--help"], {
      resolvedPath: "/tmp/symlink-bin/skill-bin",
      resolvedRealPath: "/opt/skills/skill-bin",
    });
    expect(evaluateAutoAllowSkills(command, "/opt/skills/skill-bin").allowlistSatisfied).toBe(true);
    expectAutoAllowSkillsMiss(evaluateAutoAllowSkills(command, "/tmp/symlink-bin/skill-bin"));
  });

  it("does not satisfy auto-allow skills for explicit relative paths", () => {
    expectAutoAllowSkillsMiss(
      evaluateAutoAllowSkills(
        segment(["./skill-bin", "--help"], {
          resolvedPath: "/tmp/skill-bin",
          executableName: "skill-bin",
        }),
        "/tmp/skill-bin",
      ),
    );
  });

  it("does not satisfy auto-allow skills when command resolution is missing", () => {
    expectAutoAllowSkillsMiss(
      evaluateAutoAllowSkills(segment(["skill-bin", "--help"]), "/opt/skills/skill-bin"),
    );
  });

  it("returns empty segment details for chain misses", () => {
    const command = toolSegment();
    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [command], chains: [[command]] },
      allowlist: [{ pattern: "/usr/bin/other" }],
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.allowlistMatches).toStrictEqual([]);
    expect(result.segmentSatisfiedBy).toStrictEqual([]);
  });

  it("aggregates segment satisfaction across chains", () => {
    const allowlistSegment = toolSegment();
    const safeBinSegment = headSegment();
    const result = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [allowlistSegment, safeBinSegment],
        chains: [[allowlistSegment], [safeBinSegment]],
      },
      allowlist: [{ pattern: "/usr/bin/tool" }],
      safeBins: normalizeSafeBins(["head"]),
      cwd: "/tmp",
    });
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
    expect(result.segmentSatisfiedBy).toEqual(["allowlist", "safeBins"]);
  });
});
