import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  admitSkillsObservationRoot,
  skillsObservationScope,
} from "./refresh-observation-source.js";
const roots = useAutoCleanupTempDirTracker(afterEach);

it("admits a stable parent and retains a missing descendant as a literal tree", async () => {
  const parent = await fs.realpath(roots.make("skills-authority-"));
  const target = { path: path.join(parent, "missing", "skills"), authorityPath: parent, depth: 6 };
  const authority = await admitSkillsObservationRoot(target);
  expect(authority.rootDir).toBe(parent);
  expect(await skillsObservationScope(authority, target, new AbortController().signal)).toEqual({
    path: path.join("missing", "skills"),
    kind: "tree",
    depth: 8,
  });
});

it.each(["parent", "leaf"] as const)(
  "collapses a symbolic %s to its lexical entry without scanning its target",
  async (position) => {
    const parent = await fs.realpath(roots.make("skills-symbolic-authority-"));
    const outside = await fs.realpath(roots.make("skills-outside-"));
    await fs.mkdir(path.join(outside, "skills"));
    const link = path.join(parent, "link");
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const target = {
      path: position === "parent" ? path.join(link, "skills") : link,
      authorityPath: parent,
      depth: 6,
    };
    const authority = await admitSkillsObservationRoot(target);
    expect(await skillsObservationScope(authority, target, new AbortController().signal)).toEqual({
      path: "link",
      kind: "entry",
    });
    await fs.unlink(link);
    await fs.mkdir(link);
    expect(await skillsObservationScope(authority, target, new AbortController().signal)).toEqual({
      path: path.relative(parent, target.path),
      kind: "tree",
      depth: 8,
    });
  },
);

it("rejects replacement of the admitted authority rather than repinning its pathname", async () => {
  const parent = await fs.realpath(roots.make("skills-pinned-"));
  const authorityPath = path.join(parent, "authority");
  await fs.mkdir(authorityPath);
  const target = { path: path.join(authorityPath, "skills"), authorityPath, depth: 6 };
  const authority = await admitSkillsObservationRoot(target);
  await fs.rename(authorityPath, path.join(parent, "retired"));
  await fs.mkdir(authorityPath);
  await expect(
    skillsObservationScope(authority, target, new AbortController().signal),
  ).rejects.toThrow();
});
