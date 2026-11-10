import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "./fs-safe.js";
import type { UpdateCandidatePluginCodeLink } from "./update-candidate-plugin-code-links.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
async function fixture(setup?: (plugin: string, assets: string) => Promise<void>) {
  const root = await fs.realpath(dirs.make("normalize-projector-"));
  const plugin = path.join(root, "plugin"),
    assets = path.join(root, "assets");
  const state = path.join(root, "private"),
    candidate = path.join(root, "candidate");
  await Promise.all([plugin, assets, candidate].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(plugin, "package.json"), "{}");
  await fs.writeFile(path.join(assets, "package.json"), JSON.stringify({ name: "asset-owner" }));
  await fs.writeFile(path.join(assets, "config.txt"), "original configuration");
  await fs.symlink(path.join(assets, "config.txt"), path.join(plugin, "config.txt"));
  await setup?.(plugin, assets);
  const project = (source: string) => path.join(state, path.relative(root, source));
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([plugin, assets].map((source) => [source, project(source)])),
    project,
    targetStateDir: state,
    candidateRoot: candidate,
  });
  const links: UpdateCandidatePluginCodeLink[] = [];
  return {
    plugin,
    assets,
    plan,
    links,
    project,
    copy: () =>
      copyUpdateCandidatePluginTrees(plan, {
        targetStateDir: state,
        candidateRoot: candidate,
        onCodeLink: (edge) => links.push(edge),
      }),
  };
}
it("materializes ordinary aliases with independent writes, modes and bounded byte accounting", async () => {
  const f = await fixture(async (plugin, assets) => {
    await fs.symlink(path.join(assets, "config.txt"), path.join(plugin, "second.txt"));
    await fs.mkdir(path.join(plugin, "nested"));
    await fs.writeFile(path.join(plugin, "nested", "package.json"), "{}");
    await fs.symlink("../second.txt", path.join(plugin, "nested", "config.txt"));
    await fs.link(path.join(assets, "config.txt"), path.join(assets, "hardlink.txt"));
    await fs.chmod(path.join(assets, "config.txt"), 0o640);
  });
  const oldBytes = f.plan.entries.reduce(
    (total, e) => total + Math.max(4096, Math.ceil(e.size / 4096) * 4096),
    (f.plan.hostLinks.length + f.plan.aliases.length) * 4096,
  );
  expect(f.plan.bytes - oldBytes).toBe(12288);
  await f.copy();
  const a = f.project(path.join(f.plugin, "config.txt"));
  expect((await fs.stat(a)).nlink).toBe(1);
  expect((await fs.stat(a)).mode & 0o777).toBe(0o640);
  await fs.writeFile(a, "private write");
  for (const file of [
    f.project(path.join(f.plugin, "second.txt")),
    f.project(path.join(f.plugin, "nested", "config.txt")),
    path.join(f.assets, "config.txt"),
    path.join(f.assets, "hardlink.txt"),
    f.project(path.join(f.assets, "config.txt")),
  ]) {
    expect(await fs.readFile(file, "utf8")).toBe("original configuration");
  }
  expect(f.links.some((e) => e.path === a)).toBe(false);
});
it.each([false, true])("uses the nearest regular manifest (symlink=%s)", async (symlink) => {
  const f = await fixture(async (plugin, assets) => {
    await fs.mkdir(path.join(plugin, "nested"));
    const manifest = path.join(plugin, "nested", "package.json");
    await (symlink
      ? fs.symlink(path.join(assets, "package.json"), manifest)
      : fs.writeFile(manifest, "{}"));
    await fs.writeFile(path.join(plugin, "outer.txt"), "outer");
    await fs.symlink("../outer.txt", path.join(plugin, "nested", "config.txt"));
    await fs.symlink("outer.txt", path.join(plugin, "internal.txt"));
  });
  await f.copy();
  for (const name of ["nested/config.txt", "internal.txt"]) {
    const stat = await fs.lstat(f.project(path.join(f.plugin, name)));
    expect(stat.isSymbolicLink()).toBe(name === "internal.txt" || symlink);
  }
});
it.each(
  ["target-content", "target-replace", "link-retarget"].flatMap((kind) =>
    [false, true].map((late) => ({ kind, late })),
  ),
)("checks inventory before/at alias copy: $kind, late=$late", async ({ kind, late }) => {
  const f = await fixture();
  const target = path.join(f.assets, "config.txt"),
    alias = path.join(f.plugin, "config.txt");
  const mutate = () => {
    if (kind === "target-content") {
      fsSync.writeFileSync(target, "changed");
    } else if (kind === "target-replace") {
      fsSync.renameSync(target, target + ".held");
      fsSync.writeFileSync(target, "original configuration");
    } else {
      fsSync.unlinkSync(alias);
      fsSync.symlinkSync(path.join(f.assets, "package.json"), alias);
    }
  };
  let reached = false;
  if (late) {
    const openRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const root = await openRoot(...args),
        copyIn = root.copyIn.bind(root);
      vi.spyOn(root, "copyIn").mockImplementation((relative, source, options) => {
        if (relative === path.relative(f.plan.privateRoot, f.project(alias))) {
          for (const entry of f.plan.entries.filter((e) => e.kind === "file")) {
            expect(fsSync.lstatSync(f.project(entry.path)).isFile()).toBe(true);
          }
          expect(fsSync.readFileSync(f.project(target), "utf8")).toBe("original configuration");
          reached = true;
          mutate();
        }
        return copyIn(relative, source, options);
      });
      return root;
    });
  } else {
    mutate();
  }
  if (late && kind === "link-retarget") {
    await f.copy();
    expect(await fs.readFile(f.project(alias), "utf8")).toBe("original configuration");
    expect(await fs.readlink(alias)).toBe(path.join(f.assets, "package.json"));
  } else {
    await expect(f.copy()).rejects.toThrow(/changed after snapshot inventory/);
  }
  expect(reached).toBe(late);
});
it("refuses occupied normalized destination without changing the sentinel", async () => {
  const f = await fixture();
  const destination = f.project(path.join(f.plugin, "config.txt"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, "sentinel");
  await expect(f.copy()).rejects.toThrow();
  expect(await fs.readFile(destination, "utf8")).toBe("sentinel");
  expect(await fs.readFile(path.join(f.assets, "config.txt"), "utf8")).toBe(
    "original configuration",
  );
});
it("refuses a missing target with no selected copy owner", async () => {
  await expect(
    fixture(async (plugin) => {
      const other = path.join(path.dirname(plugin), "unowned-missing", "config.txt");
      await fs.symlink(other, path.join(plugin, "missing.txt"));
    }),
  ).rejects.toThrow(/privately copy|ENOENT/);
});
it.each([
  ..."package.json .modules.yaml .bin/config.txt unknown.data mjs node so bin"
    .split(" ")
    .flatMap((name) => {
      const target = name.includes(".") || name.includes("/") ? name : "target." + name;
      const alias = name === "package.json" ? "nested/package.json" : target;
      return [
        [alias, "config.txt", false],
        ["config.txt", target, false],
      ] as const;
    }),
  ["executable.txt", "executable.txt", false] as const,
  ["data-dir", "directory", false] as const,
  ["masquerade.txt", "binary.txt", true] as const,
])("applies path/mode, not content, eligibility: %s -> %s", async (alias, target, eligible) => {
  const f = await fixture(async (plugin, assets) => {
    await fs.unlink(path.join(plugin, "config.txt"));
    await fs.mkdir(path.dirname(path.join(plugin, alias)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(assets, target)), { recursive: true });
    if (target === "directory") {
      await fs.mkdir(path.join(assets, target));
    } else if (target !== "package.json") {
      await fs.writeFile(path.join(assets, target), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await fs.chmod(path.join(assets, target), target === "executable.txt" ? 0o755 : 0o644);
    }
    await fs.symlink(path.join(assets, target), path.join(plugin, alias));
    await fs.symlink("missing.txt", path.join(plugin, "dangling.txt"));
    await fs.symlink(path.join(assets, "missing.txt"), path.join(plugin, "missing.txt"));
  });
  await f.copy();
  const destination = f.project(path.join(f.plugin, alias));
  expect((await fs.lstat(destination)).isSymbolicLink()).toBe(!eligible);
  if (eligible) {
    expect(await fs.readFile(destination)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  }
  for (const name of ["dangling.txt", "missing.txt"]) {
    const dangling = f.project(path.join(f.plugin, name));
    expect((await fs.lstat(dangling)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(dangling)).rejects.toThrow();
    expect(f.links.find((e) => e.path === dangling)?.target).toBeNull();
  }
});
