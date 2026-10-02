import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { fetchClawHubPluginSkill } from "../../infra/clawhub-plugin-skills.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readPluginSkillBundle } from "./plugin-skill-bundle.js";
import { readPluginSkill } from "./plugin-skills.js";

const tempDirs = createTrackedTempDirs();
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

async function fixture(rootPath = "skills/guide") {
  const root = await tempDirs.make("plugin-skill-bundle-");
  const rootDir = path.join(root, "plugin");
  const skillDir = path.join(rootDir, rootPath);
  const source = new Map([
    [
      "SKILL.md",
      Buffer.from(
        "---\nname: operator-guide\ndescription: Operate the plugin\n---\n# Guide\n[Reference](references/guide.md)\n",
      ),
    ],
    [
      "references/guide.md",
      Buffer.from(
        "# Full reference\n" + "Complete instructions.\n".repeat(4000) + "Final instruction.\n",
      ),
    ],
    ["scripts/unlinked.py", Buffer.from("print('not executed')\n")],
    ["assets/picture.png", Buffer.from([0x89, 0x50, 0, 0xff])],
    ["empty.txt", Buffer.alloc(0)],
  ]);
  for (const [filePath, contents] of source) {
    await fs.mkdir(path.dirname(path.join(skillDir, filePath)), { recursive: true });
    await fs.writeFile(path.join(skillDir, filePath), contents);
  }
  const record = {
    id: "example",
    origin: "global" as const,
    rootDir,
    skills: ["skills"],
    version: "1.0.0",
  };
  const read = (name = "operator-guide", selectedPath?: string) =>
    withPluginCache(createPluginCache(), () =>
      readPluginSkill(record, name, { path: selectedPath }),
    );
  const calls: URL[] = [];
  const catalog = (alter?: (value: Record<string, unknown>) => void, selectedPath?: string) =>
    fetchClawHubPluginSkill({
      packageName: "@example/plugin",
      version: "1.0.0",
      skillName: "operator-guide",
      skipAuth: true,
      path: selectedPath,
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.pathname.endsWith("/versions/1.0.0")) {
          const value = {
            package: { name: "@example/plugin" },
            version: {
              version: "1.0.0",
              pluginManifestSummary: {
                bundledSkills: [
                  {
                    name: "operator-guide",
                    rootPath,
                    skillMdPath: `${rootPath}/SKILL.md`,
                  },
                ],
              },
              files: [...source].map(([p, b]) => ({
                path: `${rootPath}/${p}`,
                size: b.length,
                sha256: createHash("sha256").update(b).digest("hex"),
              })),
            },
          };
          alter?.(value);
          return Response.json(value);
        }
        const p =
          url.searchParams
            .get("path")
            ?.replace(/^(?:\.\/)+/u, "")
            .replace(`${rootPath}/`, "") ?? "";
        const data = source.get(p);
        return new Response(data ? new Uint8Array(data) : null, { status: data ? 200 : 404 });
      },
    });
  return { root, rootDir, skillDir, record, source, calls, read, catalog };
}

describe("complete plugin skill bundles", () => {
  it("returns equivalent installed/catalog inventories, full text, unlinked files and visible binaries", async () => {
    const { read, catalog, source, calls, skillDir } = await fixture();
    const text = "# UTF-8 text\t\r\nλ\u007f\u0080\u009f";
    const controls = [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f];
    source.set("text.txt", Buffer.from(text));
    for (const code of controls) {
      source.set(`control-${code}.txt`, Buffer.from([code]));
    }
    for (const [name, bytes] of source) {
      await fs.writeFile(path.join(skillDir, name), bytes);
    }
    const installed = await read();
    expect(await catalog()).toEqual(installed);
    expect(installed.files.map((f) => f.path)).toEqual([...source.keys()].toSorted());
    expect(
      installed.files.filter((file) => file.status === "ready").map((file) => file.path),
    ).toEqual(["SKILL.md"]);
    expect(
      installed.files
        .filter((file) => file.path !== "SKILL.md")
        .every((file) => file.status === "deferred" && file.content === undefined),
    ).toBe(true);
    expect(calls).toHaveLength(2);
    for (const [filePath, bytes] of source) {
      const selected = await read("operator-guide", filePath);
      expect(await catalog(undefined, filePath)).toEqual(selected);
      const selectedFile = selected.files.find((file) => file.path === filePath)!;
      const binary = filePath === "assets/picture.png" || filePath.startsWith("control-");
      expect(selectedFile.status).toBe(binary ? "binary" : "ready");
      expect(selectedFile.content).toBe(binary ? undefined : bytes.toString());
      expect(
        selected.files
          .filter((file) => file.path !== filePath)
          .every((file) => file.status === "deferred"),
      ).toBe(true);
    }
    expect(
      calls
        .filter((url) => url.pathname.endsWith("/file"))
        .every((url) => url.searchParams.get("version") === "1.0.0"),
    ).toBe(true);
  });

  it.each([
    {
      boundary: "root depth",
      rootPath: Array.from({ length: 16 }, (_, i) => `root-${i}`).join("/"),
      filePath: "reference.md",
    },
    {
      boundary: "relative depth",
      rootPath: "skills/guide",
      filePath: [...Array.from({ length: 15 }, (_, i) => `part-${i}`), "reference.md"].join("/"),
    },
    {
      boundary: "root length",
      rootPath: `${"a".repeat(255)}/${"b".repeat(255)}`,
      filePath: "reference.md",
    },
    {
      boundary: "relative length",
      rootPath: "skills/guide",
      filePath: `${"a".repeat(255)}/${"b".repeat(252)}.md`,
    },
  ])(
    "applies $boundary limits independently to root and relative paths",
    async ({ rootPath, filePath }) => {
      const { rootDir, skillDir, source, catalog, calls } = await fixture(rootPath);
      const contents = Buffer.from("Complete boundary reference.");
      source.set(filePath, contents);
      await fs.mkdir(path.dirname(path.join(skillDir, filePath)), { recursive: true });
      await fs.writeFile(path.join(skillDir, filePath), contents);
      const installed = await readPluginSkillBundle({
        pluginRoot: rootDir,
        rootPath,
        name: "operator-guide",
        rejectHardlinks: true,
      });
      const published = await catalog((value) => {
        const version = value.version as {
          files: { path: string }[];
          pluginManifestSummary: { bundledSkills: { skillMdPath: string }[] };
        };
        version.pluginManifestSummary.bundledSkills[0]!.skillMdPath = `./${rootPath}/SKILL.md`;
        for (const file of version.files) {
          file.path = `./${file.path}`;
        }
      });
      expect(published).toEqual({ ...installed, version: "1.0.0" });
      expect(published.files.find((file) => file.path === filePath)?.status).toBe("deferred");
      expect(
        calls
          .filter((url) => url.pathname.endsWith("/file"))
          .map((url) => url.searchParams.get("path")),
      ).toEqual([`./${rootPath}/SKILL.md`]);
    },
  );

  it("reads the installed bundle through a symlinked plugin root", async () => {
    const { root, rootDir, record, read } = await fixture();
    const alias = path.join(root, "plugin-alias");
    await fs.symlink(rootDir, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await withPluginCache(createPluginCache(), () =>
      readPluginSkill({ ...record, rootDir: alias }, "operator-guide"),
    );
    expect(result).toEqual(await read());
    expect(result.rootPath).toBe("skills/guide");
  });

  it.each(["", "./"])(
    "reads a declared package-root skill with exact %s inventory paths",
    async (prefix) => {
      const { record, rootDir, source, catalog, calls } = await fixture();
      for (const [file, bytes] of source) {
        await fs.mkdir(path.dirname(path.join(rootDir, file)), { recursive: true });
        await fs.writeFile(path.join(rootDir, file), bytes);
      }
      await fs.rm(path.join(rootDir, "skills"), { recursive: true });
      const installed = await withPluginCache(createPluginCache(), () =>
        readPluginSkill({ ...record, skills: ["."] }, "operator-guide"),
      );
      const published = await catalog((value) => {
        const version = value.version as {
          files: { path: string }[];
          pluginManifestSummary: { bundledSkills: { rootPath: string; skillMdPath: string }[] };
        };
        version.pluginManifestSummary.bundledSkills[0]!.rootPath = ".";
        version.pluginManifestSummary.bundledSkills[0]!.skillMdPath = `${prefix}SKILL.md`;
        for (const file of version.files) {
          file.path = file.path.replace("skills/guide/", prefix);
        }
      });
      expect(published).toEqual(installed);
      expect(published.entryPath).toBe("SKILL.md");
      expect(
        calls
          .filter((url) => url.pathname.endsWith("/file"))
          .map((url) => url.searchParams.get("path")),
      ).toEqual([`${prefix}SKILL.md`]);
    },
  );

  it("keeps oversized content and external links visible without reading their contents", async () => {
    const { read, skillDir, root } = await fixture();
    await fs.writeFile(
      path.join(skillDir, "large.txt"),
      "x".repeat(SKILL_LIBRARY_MAX_FILE_BYTES + 1),
    );
    const privatePath = path.join(root, "outside.txt");
    await fs.writeFile(privatePath, "private fixture");
    await fs.symlink(privatePath, path.join(skillDir, "link.txt"));
    await fs.link(privatePath, path.join(skillDir, "hardlink.txt"));
    await fs.symlink(
      root,
      path.join(skillDir, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await read();
    for (const p of ["link.txt", "hardlink.txt", "outside"]) {
      const selected = await read("operator-guide", p);
      expect(selected.files.find((f) => f.path === p)).toMatchObject({ status: "unavailable" });
    }
    expect(result.files.find((f) => f.path === "large.txt")).toMatchObject({ status: "too-large" });
    expect(JSON.stringify(result)).not.toContain("private fixture");
  });

  it("rejects undeclared names, path requests and ambiguous declared names", async () => {
    const { read, rootDir, source } = await fixture();
    await expect(read("../../private/SKILL.md")).rejects.toThrow("not found");
    const duplicate = path.join(rootDir, "skills", "duplicate");
    await fs.mkdir(duplicate);
    await fs.writeFile(path.join(duplicate, "SKILL.md"), source.get("SKILL.md")!);
    await expect(read()).rejects.toThrow("ambiguous");
  });

  it.each(["version", "path", "duplicate", "alias", "control", "DEL"])(
    "rejects a catalog %s mismatch before file reads",
    async (kind) => {
      const { catalog, calls } = await fixture();
      await expect(
        catalog((value) => {
          const version = value.version as { version: string; files: { path: string }[] };
          if (kind === "version") {
            version.version = "2.0.0";
          }
          if (kind === "path") {
            version.files[0]!.path = "skills/guide/../../outside.txt";
          }
          if (kind === "control" || kind === "DEL") {
            version.files[0]!.path = `skills/guide/bad${String.fromCharCode(kind === "control" ? 0x1f : 0x7f)}.txt`;
          }
          if (kind === "duplicate") {
            version.files.push(version.files[0]!);
          }
          if (kind === "alias") {
            version.files.push({ ...version.files[0]!, path: `./${version.files[0]!.path}` });
          }
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
    },
  );

  it("rejects excess catalog tree entries before reading any file bodies", async () => {
    const { catalog, calls } = await fixture();
    await expect(
      catalog((value) => {
        const files = (value.version as { files: { path: string; size: number; sha256: string }[] })
          .files;
        for (let index = 0; index < 50; index++) {
          files.push({
            path: `skills/guide/branch-${index}/a/b/c/d/e/f/g/h/i/j/file.txt`,
            size: 0,
            sha256: createHash("sha256").update("").digest("hex"),
          });
        }
      }),
    ).rejects.toThrow("inventory limits");
    expect(calls).toHaveLength(1);
  });

  it("represents failed integrity checks without claiming the contents were read", async () => {
    const { catalog, source } = await fixture();
    const result = await catalog((value) => {
      (value.version as { files: { sha256: string }[] }).files[0]!.sha256 = "0".repeat(64);
    });
    expect(result.files.find((file) => file.path === "SKILL.md")).toEqual({
      path: "SKILL.md",
      sizeBytes: source.get("SKILL.md")!.length,
      status: "unavailable",
    });
  });

  it("shows an empty declared folder and rejects excess inventory instead of truncating", async () => {
    const { rootDir, skillDir } = await fixture();
    const empty = path.join(rootDir, "empty");
    await fs.mkdir(empty);
    const read = (rootPath: string) =>
      readPluginSkillBundle({
        pluginRoot: rootDir,
        rootPath,
        name: "guide",
        rejectHardlinks: true,
      });
    expect(await read("empty")).toMatchObject({
      files: [],
      directories: [],
      inventoryComplete: true,
    });
    await fs.mkdir(path.join(skillDir, "empty-folder"));
    expect((await read("skills/guide")).directories).toContain("empty-folder");
    await Promise.all(
      Array.from({ length: 256 }, (_, i) =>
        fs.writeFile(path.join(skillDir, `unlinked-${i}.txt`), ""),
      ),
    );
    await expect(read("skills/guide")).rejects.toThrow("file count");
  });
  it("stops catalog requests when the overall read budget expires", async () => {
    const { catalog, calls } = await fixture();
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const result = await catalog(() => {
      time += 30_001;
    });
    expect(calls).toHaveLength(1);
    expect(result.files).toHaveLength(5);
    expect(result.files.find((file) => file.path === "SKILL.md")?.status).toBe("unavailable");
    expect(
      result.files
        .filter((file) => file.path !== "SKILL.md")
        .every((file) => file.status === "deferred"),
    ).toBe(true);
  });

  it("keeps aggregate-size overflow visible in both inventories", async () => {
    const { source, skillDir, read, catalog } = await fixture();
    for (let i = 0; i < 9; i++) {
      const contents = Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES, "a");
      const name = `large-${i}.txt`;
      source.set(name, contents);
      await fs.writeFile(path.join(skillDir, name), contents);
    }
    const installed = await read();
    expect(await catalog()).toEqual(installed);
    expect(installed.files.find((file) => file.path === "large-8.txt")?.status).toBe("too-large");
    expect(installed.files).toHaveLength(source.size);
  });
  it("reads every byte of a static bundle that exactly fits the aggregate limit", async () => {
    const { rootDir, skillDir, source, catalog } = await fixture();
    await fs.rm(skillDir, { recursive: true });
    await fs.mkdir(skillDir, { recursive: true });
    source.clear();
    for (let i = 0; i < SKILL_LIBRARY_MAX_BUNDLE_BYTES / SKILL_LIBRARY_MAX_FILE_BYTES; i++) {
      const file = i === 0 ? "SKILL.md" : `part-${i}.md`;
      const contents = Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES, "a");
      source.set(file, contents);
      await fs.writeFile(path.join(skillDir, file), contents);
    }
    source.set("z-empty.txt", Buffer.alloc(0));
    await fs.writeFile(path.join(skillDir, "z-empty.txt"), "");
    const installed = await readPluginSkillBundle({
      pluginRoot: rootDir,
      rootPath: "skills/guide",
      name: "operator-guide",
      rejectHardlinks: true,
    });
    expect(await catalog()).toEqual({ ...installed, version: "1.0.0" });
    expect(installed.files.find((file) => file.path === "SKILL.md")?.status).toBe("ready");
    expect(
      installed.files
        .filter((file) => file.path !== "SKILL.md")
        .every((file) => file.status === "deferred"),
    ).toBe(true);
    expect(installed.files.reduce((bytes, file) => bytes + file.sizeBytes, 0)).toBe(
      SKILL_LIBRARY_MAX_BUNDLE_BYTES,
    );
  });

  it("bounds a growing selected file without touching unselected bodies", async () => {
    const { rootDir, skillDir } = await fixture();
    const growing = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const file = path.join(skillDir, `growing-${i}.txt`);
      await fs.writeFile(file, "x");
      growing.add(await fs.realpath(file));
    }
    const after = path.join(skillDir, "z-after.txt");
    await fs.writeFile(after, "Not read after the aggregate budget is spent.");
    const reads: Promise<number>[] = [];
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence: async (filePath, handle) => {
        if (growing.has(filePath)) {
          // Grow after Root's pinned stat. The dependency must perform its real
          // bounded read and overflow probe, not an early stat-size rejection.
          await fs.truncate(filePath, SKILL_LIBRARY_MAX_FILE_BYTES + 1);
        }
        const observed = vi.spyOn(handle, "read");
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          reads.push(
            ...observed.mock.results
              .filter((r) => r.type === "return")
              .map((r) => Promise.resolve(r.value).then((result) => result.bytesRead)),
          );
          await close();
        });
      },
    });
    const result = await readPluginSkillBundle({
      pluginRoot: rootDir,
      rootPath: "skills/guide",
      name: "operator-guide",
      rejectHardlinks: true,
      path: "growing-0.txt",
    });
    const bytesRead = (await Promise.all(reads)).reduce((sum, bytes) => sum + bytes, 0);
    expect(bytesRead).toBeGreaterThan(0);
    // fs-safe reads at most one extra byte to detect overflow.
    expect(bytesRead).toBeLessThanOrEqual(2);
    expect(result.files.find((file) => file.path === "z-after.txt")).toMatchObject({
      status: "deferred",
    });
    expect(result.files.find((file) => file.path === "growing-0.txt")?.status).toBe("too-large");
    expect(result.files).toHaveLength(15);
  });

  it("reads overlapping declarations once while preserving distinct-name ambiguity checks", async () => {
    const { record } = await fixture();
    const result = await withPluginCache(createPluginCache(), () =>
      readPluginSkill(
        {
          ...record,
          skills: ["skills", "skills/guide"],
        },
        "operator-guide",
      ),
    );
    expect(result.files).toHaveLength(5);
    expect(result.entryPath).toBe("SKILL.md");
  });
});
