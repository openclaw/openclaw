import { describe, expect, it } from "vitest";
import type { SkillStatusEntry } from "../api/types.ts";
import { computeSkillMissing } from "./skills-shared.ts";

function entry(missing: SkillStatusEntry["missing"]): SkillStatusEntry {
  return {
    name: "s",
    description: "d",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "s",
    bundled: false,
    primaryEnv: undefined,
    emoji: undefined,
    homepage: undefined,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    requirements: { bins: [], anyBins: [], env: [], anyEnv: [], config: [], os: [] },
    missing,
    configChecks: [],
    install: [],
  };
}

const empty = { bins: [], anyBins: [], env: [], anyEnv: [], config: [], os: [] };

describe("computeSkillMissing", () => {
  it("renders nothing when nothing is missing", () => {
    expect(computeSkillMissing(entry({ ...empty }))).toEqual([]);
  });

  it("renders anyEnv alternates as a group like anyBins", () => {
    expect(
      computeSkillMissing(entry({ ...empty, anyEnv: ["ELEVENLABS_API_KEY", "SAG_API_KEY"] })),
    ).toEqual(["env:any of (ELEVENLABS_API_KEY, SAG_API_KEY)"]);
  });

  it("keeps single-env entries unchanged alongside anyEnv", () => {
    expect(computeSkillMissing(entry({ ...empty, env: ["A"], anyEnv: ["B", "C"] }))).toEqual([
      "env:A",
      "env:any of (B, C)",
    ]);
  });
});
