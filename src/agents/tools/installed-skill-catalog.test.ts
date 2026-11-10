import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as fsSafe from "../../infra/fs-safe.js";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import { getTextLexicalIndex } from "../tool-search-index.js";
import * as lexical from "../tool-search-index.js";
import * as ranking from "../tool-search-ranking.js";

afterEach(() => vi.restoreAllMocks());

const temps = useAutoCleanupTempDirTracker(afterEach);

function skill(name: string, description: string, content?: string): InstalledSkill {
  return {
    name,
    description,
    location: `/skills/${name}/SKILL.md`,
    source: { filePath: `/skills/${name}/SKILL.md`, readContent: content },
  };
}

function installed(discoverySkills: Skill[]) {
  return prepareInstalledSkillCatalog({
    snapshot: {
      prompt: "",
      skills: discoverySkills.map(({ name }) => ({ name })),
      discoverySkills,
    },
    workspaceDir: "/synthetic",
  });
}

function searchBodies(catalog: InstalledSkill[], query: string) {
  return searchInstalledSkills(catalog, query, 5, undefined, () => true);
}

async function matchingNames(catalog: InstalledSkill[], query: string) {
  return (await searchBodies(catalog, query)).skills.map(({ name }) => name);
}

describe("installed skill catalog", () => {
  it.each([
    { catalogs: 5, descriptionBytes: 1 },
    { catalogs: 2, descriptionBytes: 18 * 1024 * 1024 },
    { catalogs: 1, descriptionBytes: 36 * 1024 * 1024 },
  ])(
    "bounds idle catalog retention by count and aggregate bytes (%j)",
    async ({ catalogs, descriptionBytes }) => {
      // Whitespace grows retained metadata without creating millions of postings.
      const description = `${" ".repeat(descriptionBytes)}quasar`;
      const publications = Array.from({ length: catalogs }, (_, index) => ({
        ...createCanonicalFixtureSkill({
          name: `budget-${catalogs}-${index}`,
          description,
          filePath: `node://synthetic/budget-${index}/SKILL.md`,
          baseDir: "node://synthetic",
          source: "bundled",
        }),
        contentHash: `budget-${catalogs}-${index}`,
      }));
      const prepare = vi.spyOn(lexical, "getTextLexicalIndex");
      for (const publication of [...publications, publications[0]!]) {
        const current = installed([publication]);
        expect((await searchInstalledSkills(current, "quasar")).skills[0]?.name).toBe(
          publication.name,
        );
        // Eviction limits idle sharing, not the admitted run's own current view.
        await searchInstalledSkills(current, "quasar");
      }
      expect(prepare).toHaveBeenCalledTimes(catalogs + 1);
    },
  );

  it("tokenizes large unchanged bodies once across fresh catalogs and visibility changes", async () => {
    const catalog = Array.from({ length: 135 }, (_, index) =>
      Object.freeze({
        ...createCanonicalFixtureSkill({
          name: `large-${index}`,
          description: "Guide",
          filePath: `node://synthetic/large-${index}/SKILL.md`,
          baseDir: "node://synthetic",
          source: "bundled",
        }),
        readContent: `# Body ${index}\n${"Search records and read files. ".repeat(400)}`,
        contentHash: `synthetic-body-${index}`,
      }),
    );
    const tokenize = vi.spyOn(ranking, "tokenizeDocument");
    const hash = vi.spyOn(lexical, "prepareTextLexicalDocument");
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = installed(
        catalog.slice(attempt % 2).map((entry) => Object.assign({}, entry)),
      );
      expect((await searchBodies(current, "records")).skills).toHaveLength(5);
    }
    const revised = catalog.map((entry, index) =>
      index === 0
        ? Object.freeze({
            ...entry,
            contentHash: "revised-body",
            readContent: "# Revised body nebula",
          })
        : entry,
    );
    expect(await matchingNames(installed(revised), "nebula")).toEqual(["large-0"]);
    expect(await matchingNames(installed([...catalog]), "nebula")).toEqual([]);
    expect(tokenize.mock.calls.filter(([text]) => text.startsWith("#"))).toHaveLength(136);
    // Published content revisions already identify bounded inline instructions.
    expect(hash.mock.calls.filter(([text]) => text.startsWith("#"))).toHaveLength(0);
  });

  it("reuses decoded file revisions across fresh catalogs without serializing their bodies", async () => {
    const directory = temps.make("skill-body-revision-");
    const filePath = path.join(directory, "SKILL.md");
    const content = "Astrolabe instructions for spectroscopy";
    await fs.writeFile(filePath, content);
    const decode = vi.spyOn(Buffer.prototype, "toString");
    const serialize = vi.spyOn(JSON, "stringify");
    for (const name of ["first", "second", "third"]) {
      const guide = skill(name, "Guide");
      guide.source = { filePath };
      expect(await matchingNames([guide], "astrolabe")).toEqual([name]);
    }
    expect(decode.mock.results.filter((result) => result.value === content)).toHaveLength(1);
    expect(
      serialize.mock.calls.filter(([value]) => Array.isArray(value) && value.includes(content)),
    ).toHaveLength(0);
  });

  it("refreshes body facts when admitted file revisions change or disappear", async () => {
    const directory = temps.make("skill-body-edits-");
    const filePath = path.join(directory, "SKILL.md");
    // Filesystem clock ticks need not distinguish immediate writes of equal size.
    let ctimeMs = 1;
    const open = fsSafe.openLocalFileSafely;
    vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (options) => {
      const opened = await open(options);
      if (options.filePath === filePath) {
        opened.stat.ctimeMs = ctimeMs;
      }
      return opened;
    });
    const publication = {
      ...createCanonicalFixtureSkill({
        name: "guide",
        description: "Guide",
        filePath,
        baseDir: directory,
        source: "bundled",
      }),
      contentHash: "published-before-file-edit",
    };
    const catalog = () => installed([publication]);
    await fs.writeFile(filePath, "quasars");
    await fs.utimes(filePath, 1_700_000_000, 1_700_000_000);
    const original = await fs.stat(filePath);
    expect(await matchingNames(catalog(), "quasars")).toEqual(["guide"]);
    await fs.writeFile(filePath, "pulsars");
    await fs.utimes(filePath, original.atime, original.mtime);
    expect(await fs.stat(filePath)).toMatchObject({
      ino: original.ino,
      size: original.size,
      mtimeMs: original.mtimeMs,
    });
    ctimeMs = 2;
    expect(await matchingNames(catalog(), "quasars")).toEqual([]);
    expect(await matchingNames(catalog(), "pulsars")).toEqual(["guide"]);
    const replacement = path.join(directory, "replacement");
    await fs.writeFile(replacement, "nebulae");
    await fs.utimes(replacement, original.atime, original.mtime);
    await fs.rename(replacement, filePath);
    expect(await matchingNames(catalog(), "nebulae")).toEqual(["guide"]);
    await fs.unlink(filePath);
    expect(await searchBodies(catalog(), "nebulae")).toMatchObject({
      skills: [],
      coverage: { bodyIndexed: 0, metadataOnly: 1, truncatedBodies: 0 },
    });
  });

  it.each([false, true])(
    "keeps interleaved body byte budgets separate (inline=%s)",
    async (inline) => {
      const directory = temps.make("skill-body-budgets-");
      const filePath = path.join(directory, "SKILL.md");
      const content = `${" ".repeat(6_000)}Canary`;
      await fs.writeFile(filePath, content);
      const guide = installed([
        {
          ...createCanonicalFixtureSkill({
            name: "guide",
            description: "Guide",
            filePath,
            baseDir: directory,
            source: "bundled",
          }),
          contentHash: "published-budget-body",
          readContent: inline ? content : undefined,
        },
      ])[0]!;
      const opaque = Array.from({ length: 1_023 }, (_, index) => ({
        ...skill(`opaque-${index}`, "Guide"),
        reader: async () => "Opaque",
      }));
      for (const broad of [true, false, true, false]) {
        expect(await matchingNames(broad ? [guide, ...opaque] : [guide], "canary")).toEqual(
          broad ? [] : ["guide"],
        );
      }
    },
  );

  it("searches bounded inline bodies without encoding them again", async () => {
    const catalog = [
      skill("plain", "Guide", "Spectroscopy"),
      skill("unicode", "Guide", "価格 😀 spectroscopy"),
      skill("long", "Guide", `Spectroscopy ${" ".repeat(20_000)}`),
    ];
    const encode = vi.spyOn(Buffer, "from");
    expect(await matchingNames(catalog, "spectroscopy")).toEqual(["long", "plain", "unicode"]);
    expect(encode.mock.calls.filter(([value]) => typeof value === "string")).toHaveLength(0);
  });

  it.each([
    ["価格 ".repeat(5_000), true, `${"価格 ".repeat(2_340)}価�`],
    [`${" ".repeat(16_383)}😀`, true, `${" ".repeat(16_383)}�`],
    ["Spectroscopy \ud800", false, "Spectroscopy �"],
  ] as const)(
    "preserves byte-bounded inline search text (%#)",
    async (content, truncated, expected) => {
      const index = vi.spyOn(ranking, "tokenizeDocument");
      const result = await searchBodies([skill("bounded", "Guide", content)], "bounded");
      expect(index).toHaveBeenCalledWith(expected);
      expect(result.coverage?.truncatedBodies ?? 0).toBe(Number(truncated));
    },
  );

  it("keeps an emoji whole at the description cap", async () => {
    const prefix = "a".repeat(511);
    const found = await searchInstalledSkills([skill("guide", `${prefix}😀tail`)], "guide");
    expect(found.skills[0]?.description).toBe(prefix);
  });

  it("shares body postings across runs while binding results, readers, and permissions per run", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const serialize = vi.spyOn(JSON, "stringify");
    const metadata = { name: "shared", description: "Metadata" };
    const publication = Object.freeze({
      ...createCanonicalFixtureSkill({
        ...metadata,
        filePath: "node://synthetic/shared/SKILL.md",
        baseDir: "node://synthetic/shared",
        source: "bundled",
      }),
      contentHash: "shared-original",
    });
    const catalogs = Array.from({ length: 20 }, (_, run) => {
      const catalog = installed([publication]);
      const guide = catalog[0]!;
      guide.location = `/run-${run}/guide`;
      guide.readSearchContent = vi.fn(async () => "Spectroscopy");
      return catalog;
    });
    const results = await Promise.all(
      catalogs.map((catalog) => searchBodies(catalog, "spectroscopy")),
    );
    for (const [run, result] of results.entries()) {
      expect(result.skills).toEqual([{ ...metadata, location: `/run-${run}/guide` }]);
      expect(catalogs[run]![0]!.readSearchContent).toHaveBeenCalledOnce();
    }
    expect(build).toHaveBeenCalledTimes(2);
    expect(
      serialize.mock.calls.filter(
        ([value]) => Array.isArray(value) && value.includes("shared Metadata"),
      ),
    ).toHaveLength(1);
    expect((await searchInstalledSkills(catalogs[1]!, "spectroscopy")).skills).toEqual([]);
    catalogs[0]![0]!.assertCurrent = () => {
      throw new Error("Run retired");
    };
    await expect(searchBodies(catalogs[0]!, "spectroscopy")).rejects.toThrow("Run retired");
    expect((await searchBodies(catalogs[1]!, "spectroscopy")).skills[0]?.location).toBe(
      "/run-1/guide",
    );
    expect(build).toHaveBeenCalledTimes(2);
    await expect(
      searchInstalledSkills(catalogs[1]!, "spectroscopy", 5, AbortSignal.abort(), () => true),
    ).rejects.toThrow();
    const revised = installed([
      Object.freeze({
        ...publication,
        contentHash: "shared-revised",
        description: "Astronomy",
        readContent: "Astrometry",
      }),
    ]);
    expect((await searchBodies(revised, "astrometry")).skills).toEqual([
      { name: "shared", description: "Astronomy", location: publication.filePath },
    ]);
    expect((await searchBodies(revised, "spectroscopy")).skills).toEqual([]);
    expect((await searchBodies(catalogs[1]!, "spectroscopy")).skills).toHaveLength(1);
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("revisions body content and eligible membership without retaining another run's mapping", async () => {
    const first = [skill("a", "Metadata", "Pulsar"), skill("b", "Metadata", "Geology")];
    expect(await matchingNames(first, "pulsar")).toEqual(["a"]);
    const revised = [skill("b", "Metadata", "Pulsar"), skill("a", "Metadata", "Geology")];
    expect(await matchingNames(revised, "pulsar")).toEqual(["b"]);
    const filtered = [skill("a", "Metadata", "Geology")];
    expect(await matchingNames(filtered, "pulsar")).toEqual([]);
    const unreadable = skill("opaque", "Metadata");
    unreadable.reader = async () => "Opaque reader must not be indexed";
    expect(await searchBodies([unreadable, ...revised], "pulsar")).toMatchObject({
      skills: [{ name: "b" }],
      coverage: { bodyIndexed: 2, metadataOnly: 1, truncatedBodies: 0 },
    });
  });

  it("reuses a live body revision after idle-cache eviction", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const first = [skill("retained", "Metadata", "Astrometric")];
    await searchBodies(first, "astrometric");
    for (let revision = 0; revision < 33; revision += 1) {
      getTextLexicalIndex([`Eviction pressure ${revision}`]);
    }
    const before = build.mock.calls.length;
    const second = [skill("retained", "Metadata", "Astrometric")];
    const result = await searchBodies(second, "astrometric");
    expect(result.skills[0]?.name).toBe("retained");
    // Metadata has no run-held reference; body postings do.
    const bodyBuilds = build.mock.calls
      .slice(before)
      .filter(([documents]) => documents.some(({ terms }) => terms.has("astrometric")));
    expect(bodyBuilds).toHaveLength(0);
    expect(await matchingNames(first, "astrometric")).toEqual(["retained"]);
  });

  it("ranks an exact identity first and searches the entire prepared catalog", async () => {
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    const skills = [
      skill("alpha", "Release checks"),
      skill("releases", "Prepare a software release"),
      skill("zulu", "Audit database migrations"),
    ];
    expect((await searchInstalledSkills(skills, "releases", 1)).skills[0]?.name).toBe("releases");
    expect((await searchInstalledSkills(skills, "database migration")).skills[0]?.name).toBe(
      "zulu",
    );
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
    [["Deploy", "deploy"], "Deploy", "Deploy"],
    [["deploy"], "DEPLOY", "deploy"],
  ] as const)(
    "preserves exact identity with catalog %j and query %s",
    async (names, query, expected) => {
      const skills = names.map((name) => skill(name, "Deployment", name));
      const result = await searchInstalledSkills(skills, query, 1);
      expect(result.skills[0]?.name).toBe(expected);
      expect((await readInstalledSkill(skills, result.skills[0]?.name ?? "")).content).toBe(
        expected,
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
    expect((await searchInstalledSkills([skill("web", "Web")], "today")).skills).toEqual([]);
    await expect(searchInstalledSkills(skills, " ")).rejects.toThrow("query");
    await expect(searchInstalledSkills(skills, "x".repeat(1_001))).rejects.toThrow("query");
    await expect(searchInstalledSkills(skills, "deploy", 21)).rejects.toThrow("limit");
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
    const complete = await searchBodies([guide], "canary");
    expect(complete.skills[0]?.name).toBe("guide");
    expect(complete.coverage).toBeUndefined();
    const instructions = `${prefix}\nHidden-tail instructions.\n`;
    await fs.writeFile(filePath, instructions);
    const catalog = [guide];
    expect(await searchBodies(catalog, "canary")).toMatchObject({
      skills: [{ name: "guide" }],
      coverage: { bodyIndexed: 1, metadataOnly: 0, truncatedBodies: 1 },
    });
    expect(await matchingNames(catalog, "hidden-tail")).toEqual([]);
    expect((await readInstalledSkill(catalog, "guide")).content).toBe(instructions);
    await fs.truncate(filePath, 256 * 1024 + 1);
    await expect(readInstalledSkill(catalog, "guide")).rejects.toThrow(/large|size|limit/i);
  });
});
