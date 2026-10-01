import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

function skill(name: string, description: string, content = "Whole instructions"): InstalledSkill {
  return {
    name,
    description,
    location: `/skills/${name}/SKILL.md`,
    source: { filePath: `/skills/${name}/SKILL.md`, readContent: content },
  };
}

describe("installed skill catalog", () => {
  it("ranks an exact identity first and searches the entire prepared catalog", () => {
    const skills = [
      skill("alpha", "Release checks"),
      skill("releases", "Prepare a software release"),
      skill("zulu", "Audit database migrations"),
    ];
    expect(searchInstalledSkills(skills, "releases", 1).skills[0]?.name).toBe("releases");
    expect(searchInstalledSkills(skills, "database migration").skills).toEqual([
      { name: "zulu", description: "Audit database migrations", location: "/skills/zulu/SKILL.md" },
    ]);
    expect(searchInstalledSkills(skills, "unrelated")).toEqual({ skills: [], hasMore: false });
  });

  it("bounds metadata and uses deterministic ties without tool-specific expansions", () => {
    const skills = Array.from({ length: 25 }, (_, i) =>
      skill(`guide-${String(i).padStart(2, "0")}`, `Deploy ${"x".repeat(1_000)}`),
    ).toReversed();
    const result = searchInstalledSkills(skills, "deploy", 20);
    expect(result.skills).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.skills[0]?.name).toBe("guide-00");
    expect(result.skills.every((entry) => entry.description.length <= 512)).toBe(true);
    expect(searchInstalledSkills([skill("web", "Search the web")], "today").skills).toEqual([]);
    expect(() => searchInstalledSkills(skills, " ")).toThrow("query");
    expect(() => searchInstalledSkills(skills, "x".repeat(1_001))).toThrow("query");
    expect(() => searchInstalledSkills(skills, "deploy", 21)).toThrow("limit");
  });

  it("reads only an exact eligible identity through its owner and preserves the whole body", async () => {
    const reader = vi.fn(async () => "# Guide\n\nRun this.\nTHE END");
    const guide = skill("guide", "A guide");
    guide.source.readContent = undefined;
    guide.reader = reader;
    expect(await readInstalledSkill([guide], "guide")).toBe("# Guide\n\nRun this.\nTHE END");
    expect(reader).toHaveBeenCalledWith({ location: guide.location, signal: undefined });
    await expect(readInstalledSkill([guide], "../hidden")).rejects.toThrow(
      "Unknown installed skill",
    );
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized instructions and cancellation, including inline content", async () => {
    await expect(
      readInstalledSkill([skill("large", "Large", "x".repeat(256 * 1024 + 1))], "large"),
    ).rejects.toThrow("instruction limit");
    await expect(
      readInstalledSkill([skill("guide", "Guide")], "guide", AbortSignal.abort()),
    ).rejects.toThrow();
    const controller = new AbortController();
    const guide = skill("guide", "Guide");
    guide.source.readContent = undefined;
    guide.reader = async () => {
      controller.abort();
      return "Must not reach the model";
    };
    await expect(readInstalledSkill([guide], "guide", controller.signal)).rejects.toThrow();
  });

  it("bounds local file reads even when an admitted instruction file grows", async () => {
    const directory = temps.make("installed-skill-read-");
    const filePath = path.join(directory, "SKILL.md");
    await fs.writeFile(filePath, "Complete instructions");
    const guide = skill("guide", "Guide");
    guide.source = { filePath };
    expect(await readInstalledSkill([guide], "guide")).toBe("Complete instructions");
    await fs.truncate(filePath, 256 * 1024 + 1);
    await expect(readInstalledSkill([guide], "guide")).rejects.toThrow(/large|size|limit/i);
  });
});
