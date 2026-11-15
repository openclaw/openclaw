import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { installSkillFromSource } from "./source-install.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

async function writeSkill(directory: string, content: string) {
  await fs.mkdir(directory, { recursive: true });
  const markdown = `---\nname: local-guide\ndescription: A local guide\n---\n${content}\n`;
  await fs.writeFile(path.join(directory, "SKILL.md"), markdown);
  await fs.writeFile(path.join(directory, "asset.txt"), content);
  return markdown;
}

it.skipIf(process.platform === "win32").each(["trailing-space", "physical-parent"])(
  "installs the selected %s source instead of a valid decoy",
  async (kind) => {
    const root = tempDirs.make("skill-source-path-");
    const decoy = path.join(root, "source");
    let selected = `${decoy} `;
    let spec = selected;
    if (kind === "physical-parent") {
      const nested = path.join(root, "physical", "nested");
      await fs.mkdir(nested, { recursive: true });
      const alias = path.join(root, "selected");
      await fs.symlink(nested, alias);
      selected = path.join(root, "physical", "source");
      spec = `${alias}/../source`;
    }
    const expected = await writeSkill(selected, "selected source");
    const decoyBytes = await writeSkill(decoy, "decoy source");
    const result = await installSkillFromSource({
      workspaceDir: path.join(root, "workspace"),
      spec,
      slug: "installed-guide",
    });
    expect(await fs.readFile(path.join(result.targetDir, "SKILL.md"), "utf8")).toBe(expected);
    expect(await fs.readFile(path.join(result.targetDir, "asset.txt"), "utf8")).toBe(
      "selected source",
    );
    const origin = JSON.parse(
      await fs.readFile(path.join(result.targetDir, ".openclaw", "source-origin.json"), "utf8"),
    );
    expect(origin).toMatchObject({ source: "path", spec, slug: "installed-guide" });
    expect(await fs.readFile(path.join(decoy, "SKILL.md"), "utf8")).toBe(decoyBytes);
    expect(await fs.readFile(path.join(selected, "SKILL.md"), "utf8")).toBe(expected);
  },
);

it("does not install a neighbouring skill through a missing source component", async () => {
  const root = tempDirs.make("skill-source-missing-");
  await writeSkill(path.join(root, "source"), "must not install");
  const workspaceDir = path.join(root, "workspace");
  await expect(
    installSkillFromSource({
      workspaceDir,
      spec: `${root}${path.sep}missing${path.sep}..${path.sep}source`,
    }),
  ).rejects.toThrow(/ENOENT|not found/);
  expect(await fs.stat(path.join(workspaceDir, "skills")).catch(() => undefined)).toBeUndefined();
});
