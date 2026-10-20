import { expect, it } from "vitest";
import { resolveSafeBins } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { evaluateExecAllowlist } from "./exec-approvals.js";

function segment(
  argv: [string, ...string[]],
  paths: { resolvedPath?: string; resolvedRealPath?: string; executableName?: string } = {},
) {
  const execution = makeMockExecutableResolution({
    rawExecutable: argv[0],
    executableName: argv[0],
    ...paths,
  });
  return { raw: argv.join(" "), argv, resolution: makeMockCommandResolution({ execution }) };
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
  expect(result).toMatchObject({ allowlistSatisfied: false, segmentSatisfiedBy: [null] });
}

it("matches auto-allow skill bins against the executable trust realpath", () => {
  const command = segment(["skill-bin", "--help"], {
    resolvedPath: "/tmp/symlink-bin/skill-bin",
    resolvedRealPath: "/opt/skills/skill-bin",
  });
  expect(evaluateAutoAllowSkills(command, "/opt/skills/skill-bin").allowlistSatisfied).toBe(true);
  expectAutoAllowSkillsMiss(evaluateAutoAllowSkills(command, "/tmp/symlink-bin/skill-bin"));
});

it.each([
  [
    "explicit relative paths",
    segment(["./skill-bin", "--help"], {
      resolvedPath: "/tmp/skill-bin",
      executableName: "skill-bin",
    }),
    "/tmp/skill-bin",
  ],
  ["missing resolution", segment(["skill-bin", "--help"]), "/opt/skills/skill-bin"],
] as const)("does not auto-allow skills with %s", (_reason, command, trustedPath) => {
  expectAutoAllowSkillsMiss(evaluateAutoAllowSkills(command, trustedPath));
});

it("returns empty segment details for chain misses", () => {
  const command = segment(["tool"], { resolvedPath: "/usr/bin/tool" });
  const result = evaluateExecAllowlist({
    analysis: { ok: true, segments: [command], chains: [[command]] },
    allowlist: [{ pattern: "/usr/bin/other" }],
    safeBins: new Set(),
    cwd: "/tmp",
  });
  expect(result.allowlistSatisfied).toBe(false);
  expect([result.allowlistMatches, result.segmentSatisfiedBy]).toStrictEqual([[], []]);
});

it("aggregates segment satisfaction across chains", () => {
  const allowlistSegment = segment(["tool"], { resolvedPath: "/usr/bin/tool" });
  const safeBinSegment = segment(["head", "-n", "1"], {
    resolvedPath: "/usr/bin/head",
    resolvedRealPath: "/usr/bin/head",
  });
  const result = evaluateExecAllowlist({
    analysis: {
      ok: true,
      segments: [allowlistSegment, safeBinSegment],
      chains: [[allowlistSegment], [safeBinSegment]],
    },
    allowlist: [{ pattern: "/usr/bin/tool" }],
    safeBins: resolveSafeBins(["head"]),
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
