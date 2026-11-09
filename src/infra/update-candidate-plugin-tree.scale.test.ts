import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["copy", "retain"] as const)(
  "preserves dense dependency ownership through %s and source replacement",
  async (mode) => {
    const root = await fs.realpath(dirs.make("runtime-path-graph-"));
    const source = path.join(root, "source");
    const targetStateDir = path.join(root, "private");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(candidateRoot);
    const project = (file: string) => path.join(targetStateDir, path.relative(source, file));
    const owners = Array.from({ length: 32 }, (_, index) => path.join(source, `package-${index}`));
    const discovered = path.join(source, "discovered");
    for (const [index, owner] of [...owners, discovered].entries()) {
      await fs.mkdir(owner, { recursive: true });
      await fs.writeFile(
        path.join(owner, "package.json"),
        JSON.stringify({ name: `package-${index}`, type: "module" }),
      );
      await fs.writeFile(path.join(owner, "value.mjs"), `export default ${index};\n`);
    }
    for (const owner of owners) {
      for (const [index, target] of [...owners, discovered].entries()) {
        await fs.symlink(
          process.platform === "win32" ? target : path.relative(owner, target) || ".",
          path.join(owner, `link-${index}`),
          "junction",
        );
      }
    }
    // The discovered package is omitted from the initial roots. A later discovery
    // wave must invalidate coverage, while prefix siblings stay independently owned.
    const plan = await prepareUpdateCandidatePluginTrees({
      roots: new Map(owners.map((owner) => [owner, project(owner)])),
      project,
      targetStateDir,
      candidateRoot,
    });
    expect(plan.copies).toHaveLength(33);
    expect(new Set(plan.copies.map(([owner]) => owner))).toEqual(new Set([...owners, discovered]));
    expect(plan.edges).toHaveLength(32 * 33);
    if (mode === "copy") {
      await copyUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot });
    } else {
      await linkUpdateCandidatePluginTrees(plan, {
        targetStateDir,
        candidateRoot,
        assertCurrent: () => {},
      });
    }
    await fs.rename(source, path.join(root, "replaced-source"));
    for (const owner of owners) {
      for (const [index, target] of [...owners, discovered].entries()) {
        expect(await fs.realpath(path.join(project(owner), `link-${index}`))).toBe(project(target));
      }
    }
    const entry = path.join(project(owners[0]!), "link-32", "value.mjs");
    const result = await runCommandBuffered(
      [
        process.execPath,
        "--input-type=module",
        "-e",
        `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).default)`,
      ],
      { timeoutMs: 10_000 },
    );
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("32");
  },
);
