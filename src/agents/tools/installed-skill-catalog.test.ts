import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";
import { getTextLexicalIndex } from "../tool-search-index.js";
import * as ranking from "../tool-search-ranking.js";

afterEach(() => vi.restoreAllMocks());

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
  it("shares body postings across runs while binding results, readers, and permissions per run", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const catalogs = Array.from({ length: 20 }, (_, run) => {
      const guide = skill("shared-guide", "Shared catalog metadata");
      guide.location = `/run-${run}/guide`;
      guide.source.readContent = undefined;
      guide.readSearchContent = vi.fn(async () => "Nebular spectroscopy instructions");
      return [guide];
    });
    const results = await Promise.all(
      catalogs.map((catalog) =>
        searchInstalledSkills(catalog, "spectroscopy", 5, undefined, () => true),
      ),
    );
    for (const [run, result] of results.entries()) {
      expect(result.skills).toEqual([
        {
          name: "shared-guide",
          description: "Shared catalog metadata",
          location: `/run-${run}/guide`,
        },
      ]);
      expect(catalogs[run]![0]!.readSearchContent).toHaveBeenCalledOnce();
    }
    expect(build).toHaveBeenCalledTimes(2);
    const denied = [
      skill("shared-guide", "Shared catalog metadata", "Nebular spectroscopy instructions"),
    ];
    expect((await searchInstalledSkills(denied, "spectroscopy")).skills).toEqual([]);
    catalogs[0]![0]!.assertCurrent = () => {
      throw new Error("Run retired");
    };
    await expect(
      searchInstalledSkills(catalogs[0]!, "spectroscopy", 5, undefined, () => true),
    ).rejects.toThrow("Run retired");
    expect(
      (await searchInstalledSkills(catalogs[1]!, "spectroscopy", 5, undefined, () => true))
        .skills[0]?.location,
    ).toBe("/run-1/guide");
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("revisions body content and eligible membership without retaining another run's mapping", async () => {
    const first = [
      skill("revision-a", "Revision metadata", "Pulsar timing"),
      skill("revision-b", "Revision metadata", "Volcanic geology"),
    ];
    expect(
      (await searchInstalledSkills(first, "pulsar", 5, undefined, () => true)).skills.map(
        ({ name }) => name,
      ),
    ).toEqual(["revision-a"]);
    const revised = [
      skill("revision-b", "Revision metadata", "Pulsar timing"),
      skill("revision-a", "Revision metadata", "Volcanic geology"),
    ];
    expect(
      (await searchInstalledSkills(revised, "pulsar", 5, undefined, () => true)).skills.map(
        ({ name }) => name,
      ),
    ).toEqual(["revision-b"]);
    const filtered = [skill("revision-a", "Revision metadata", "Volcanic geology")];
    expect(
      (await searchInstalledSkills(filtered, "pulsar", 5, undefined, () => true)).skills,
    ).toEqual([]);
    const unreadable = skill("revision-0", "Revision metadata");
    unreadable.source.readContent = undefined;
    unreadable.reader = async () => "Opaque reader must not be indexed";
    expect(
      await searchInstalledSkills([unreadable, ...revised], "pulsar", 5, undefined, () => true),
    ).toMatchObject({
      skills: [{ name: "revision-b" }],
      coverage: { bodyIndexed: 2, metadataOnly: 1, truncatedBodies: 0 },
    });
  });

  it("reuses a live body revision after idle-cache eviction", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const first = [skill("retained-guide", "Retained metadata", "Astrometric calibration")];
    await searchInstalledSkills(first, "astrometric", 5, undefined, () => true);
    for (let revision = 0; revision < 33; revision += 1) {
      getTextLexicalIndex([`Eviction pressure ${revision}`]);
    }
    const before = build.mock.calls.length;
    const second = [skill("retained-guide", "Retained metadata", "Astrometric calibration")];
    const result = await searchInstalledSkills(second, "astrometric", 5, undefined, () => true);
    expect(result.skills[0]?.name).toBe("retained-guide");
    // Metadata has no run-held reference; body postings do.
    const bodyBuilds = build.mock.calls
      .slice(before)
      .filter(([documents]) => documents.some(({ terms }) => terms.includes("astrometric")));
    expect(bodyBuilds).toHaveLength(0);
    expect(
      (await searchInstalledSkills(first, "astrometric", 5, undefined, () => true)).skills[0]?.name,
    ).toBe("retained-guide");
  });

  it("ranks an exact identity first and searches the entire prepared catalog", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const skills = [
      skill("alpha", "Release checks"),
      skill("releases", "Prepare a software release"),
      skill("zulu", "Audit database migrations"),
    ];
    expect((await searchInstalledSkills(skills, "releases", 1)).skills[0]?.name).toBe("releases");
    expect((await searchInstalledSkills(skills, "database migration")).skills).toEqual([
      { name: "zulu", description: "Audit database migrations", location: "/skills/zulu/SKILL.md" },
    ]);
    expect(await searchInstalledSkills(skills, "unrelated")).toEqual({
      skills: [],
      hasMore: false,
      coverage: { bodyIndexed: 0, metadataOnly: 3, truncatedBodies: 0 },
    });
    expect(build).toHaveBeenCalledTimes(1);
    const refreshed = skills.map(({ name, description }) => skill(name, description));
    for (const item of refreshed) {
      item.location = `/current/${item.name}`;
    }
    expect((await searchInstalledSkills(refreshed, "database migration")).skills[0]?.location).toBe(
      "/current/zulu",
    );
    expect(build).toHaveBeenCalledTimes(1);
    refreshed[2]!.description = "Inspect nebulae";
    expect((await searchInstalledSkills(refreshed, "nebulae")).skills[0]?.name).toBe("zulu");
    expect(build).toHaveBeenCalledTimes(2);
  });

  it.each([
    [["deploy", "Deploy"], "Deploy", "Deploy"],
    [["Deploy", "deploy"], "deploy", "deploy"],
    [["Deploy", "deploy"], "Deploy", "Deploy"],
    [["deploy", "Deploy"], "deploy", "deploy"],
    [["deploy"], "DEPLOY", "deploy"],
  ] as const)(
    "preserves exact identity with catalog %j and query %s",
    async (names, query, expected) => {
      const skills = names.map((name) =>
        skill(name, "Deployment workflow", `${name} instructions`),
      );
      const result = await searchInstalledSkills(skills, query, 1);
      expect(result.skills[0]?.name).toBe(expected);
      expect(await readInstalledSkill(skills, result.skills[0]?.name ?? "")).toBe(
        `${expected} instructions`,
      );
    },
  );

  it("bounds metadata and uses deterministic ties without tool-specific expansions", async () => {
    const skills = Array.from({ length: 25 }, (_, i) =>
      skill(`guide-${String(i).padStart(2, "0")}`, `Deploy ${"x".repeat(1_000)}`),
    ).toReversed();
    const result = await searchInstalledSkills(skills, "deploy", 20);
    expect(result.skills).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.skills[0]?.name).toBe("guide-00");
    expect(result.skills.every((entry) => entry.description.length <= 512)).toBe(true);
    expect((await searchInstalledSkills([skill("web", "Search the web")], "today")).skills).toEqual(
      [],
    );
    await expect(searchInstalledSkills(skills, " ")).rejects.toThrow("query");
    await expect(searchInstalledSkills(skills, "x".repeat(1_001))).rejects.toThrow("query");
    await expect(searchInstalledSkills(skills, "deploy", 21)).rejects.toThrow("limit");
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

  it("indexes local prefixes without truncating whole instruction reads", async () => {
    const directory = temps.make("installed-skill-read-");
    const filePath = path.join(directory, "SKILL.md");
    const prefix = "Canary ".padEnd(16 * 1024, "x");
    await fs.writeFile(filePath, prefix);
    const guide = skill("guide", "Guide");
    guide.source = { filePath };
    const complete = await searchInstalledSkills([guide], "canary", 5, undefined, () => true);
    expect(complete.skills[0]?.name).toBe("guide");
    expect(complete.coverage).toBeUndefined();
    const instructions = `${prefix}\nHidden-tail instructions.\n`;
    await fs.writeFile(filePath, instructions);
    const catalog = [guide];
    expect(await searchInstalledSkills(catalog, "canary", 5, undefined, () => true)).toMatchObject({
      skills: [{ name: "guide" }],
      coverage: { bodyIndexed: 1, metadataOnly: 0, truncatedBodies: 1 },
    });
    expect(
      (await searchInstalledSkills(catalog, "hidden-tail", 5, undefined, () => true)).skills,
    ).toEqual([]);
    expect(await readInstalledSkill(catalog, "guide")).toBe(instructions);
    await fs.truncate(filePath, 256 * 1024 + 1);
    await expect(readInstalledSkill(catalog, "guide")).rejects.toThrow(/large|size|limit/i);
  });
});
