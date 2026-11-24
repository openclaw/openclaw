import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import {
  copyUpdateCandidatePlugins,
  prepareUpdateCandidatePlugins,
} from "./update-candidate-plugins.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-boundaries-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function writeText(directory: string, file: string, text: string) {
  const target = path.join(directory, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}
async function link(target: string, alias: string) {
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.symlink(target, alias, "file");
}
const pluginConfig = (paths: string[]): OpenClawConfig => ({ plugins: { load: { paths } } });

it.skipIf(process.platform === "win32")(
  "bounds external file links inside a shared package scope",
  async () => {
    await writeText(root, "package.json", "{}");
    const plugin = path.join(root, "plugin");
    const source = path.join(root, "assets", "config.txt");
    await writeText(plugin, "package.json", '{"name":"plugin"}');
    await writeText(path.dirname(source), path.basename(source), "preserved");
    await link(path.join(root, "missing-target"), path.join(root, "assets", "unrelated"));
    await link(source, path.join(plugin, "config.txt"));
    const params = {
      config: pluginConfig([plugin]),
      stateDir: path.join(root, "source-state"),
      targetStateDir: path.join(root, "snapshot"),
      candidateRoot: root,
    };
    const paths = await copyUpdateCandidatePlugins(
      await prepareUpdateCandidatePlugins(params),
      params,
    );
    const copied = path.join(paths[plugin]!, "config.txt");
    expect(await fs.readFile(copied, "utf8")).toBe("preserved");
    expect((await fs.realpath(copied)).startsWith(params.targetStateDir + path.sep)).toBe(true);
    expect(
      (await listDirectoryTreeStrict(params.targetStateDir)).some(
        (entry) => path.basename(entry.relativePath) === "unrelated",
      ),
    ).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses file links into private snapshot state",
  async () => {
    const plugin = path.join(root, "plugin");
    const targetStateDir = path.join(root, "snapshot");
    await writeText(root, "package.json", "{}");
    await writeText(plugin, "package.json", '{"name":"plugin"}');
    const source = path.join(targetStateDir, "private.txt");
    await writeText(targetStateDir, "private.txt", "private snapshot bytes");
    await link(source, path.join(plugin, "config.txt"));
    await expect(
      prepareUpdateCandidatePlugins({
        config: pluginConfig([plugin]),
        stateDir: path.join(root, "source-state"),
        targetStateDir,
        candidateRoot: root,
      }),
    ).rejects.toThrow("Plugin copy source overlaps update state");
    expect(await fs.readFile(source, "utf8")).toBe("private snapshot bytes");
  },
);
