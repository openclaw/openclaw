import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "./hash-skill.js";
import { createDeterministicSkillBundle } from "./package-skill.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-package-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("createDeterministicSkillBundle", () => {
  it("produces the same hash for the same source files", async () => {
    const skillDir = makeTmpDir();
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\n", "utf-8");
    await fs.mkdir(path.join(skillDir, "lib"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "lib", "index.ts"), 'export const x = "ok";\n', "utf-8");

    const first = await createDeterministicSkillBundle({
      skillDir,
      skillName: "demo-skill",
      version: "1.0.0",
      publisher: { publisherId: "radar" },
    });
    const second = await createDeterministicSkillBundle({
      skillDir,
      skillName: "demo-skill",
      version: "1.0.0",
      publisher: { publisherId: "radar" },
    });

    expect(sha256Bytes(first.bundle)).toBe(sha256Bytes(second.bundle));
  });

  it("writes _meta.json with sorted source file list", async () => {
    const skillDir = makeTmpDir();
    await fs.writeFile(path.join(skillDir, "b.ts"), "export const b = 1;\n", "utf-8");
    await fs.writeFile(path.join(skillDir, "a.ts"), "export const a = 1;\n", "utf-8");

    const packaged = await createDeterministicSkillBundle({
      skillDir,
      skillName: "sort-check",
      version: "2.0.0",
      publisher: { publisherId: "radar" },
    });
    const zip = await JSZip.loadAsync(packaged.bundle);
    const meta = JSON.parse(await zip.file("_meta.json")!.async("string"));

    expect(meta.sourceFiles).toEqual(["a.ts", "b.ts"]);
    expect(meta.packageHashSha256).toBeNull();
  });
});
