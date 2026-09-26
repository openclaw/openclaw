import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceTargetDiscovery,
  excludeSourceTarget,
  sourceTargetPaths,
  type SourceTargetGroup,
} from "../../scripts/watch-node-source-targets.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const signal = () => new AbortController().signal;
const ignored = (name: string) =>
  name.endsWith(".test.ts") || name.split(path.sep).includes("node_modules");
async function directoryLink(target: string, link: string) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
function mapped(groups: SourceTargetGroup[], physical: string) {
  return groups.flatMap((group) =>
    sourceTargetPaths(group, path.relative(group.authority.rootReal, physical)),
  );
}

describe("developer linked-source admission", () => {
  it("follows an intermediate package alias, groups shared targets, and filters lexically", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "packages"));
    await fs.mkdir(path.join(outside, "foo", "src"), { recursive: true });
    await directoryLink(path.join(outside, "foo"), path.join(cwd, "packages", "foo"));
    await directoryLink(path.join(outside, "foo"), path.join(cwd, "packages", "bar"));
    const discovery = createSourceTargetDiscovery(
      cwd,
      ["packages/foo/src", "packages/bar/src"],
      ignored,
    );
    const groups = await discovery.discover(signal());
    expect(groups).toHaveLength(2);
    expect(expectDefined(groups[0], "admitted observation").scopes).toEqual([
      { path: "packages", kind: "tree", depth: 128 },
    ]);
    expect(mapped(groups, path.join(outside, "foo", "src", "main.ts"))).toEqual([
      path.join(cwd, "packages", "bar", "src", "main.ts"),
      path.join(cwd, "packages", "foo", "src", "main.ts"),
    ]);
    const external = groups.find((group) => group.authority.rootReal === outside)!;
    expect(
      excludeSourceTarget(
        external,
        { path: path.join("foo", "src", "skip.test.ts"), kind: "file" },
        ignored,
      ),
    ).toBe(true);
    expect(
      excludeSourceTarget(external, { path: path.join("foo", "other.ts"), kind: "file" }, ignored),
    ).toBe(true);
    expect(sourceTargetPaths(external, "../../not-authorized.ts")).toEqual([]);
  });

  it("rebuilds link addition, retarget, removal, and dangling destination creation with pinned Roots", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "src"));
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    const initial = await discovery.discover(signal());
    const alias = path.join(cwd, "src", "linked");
    const destination = path.join(outside, "missing", "deep");
    await directoryLink(destination, alias);
    const dangling = await discovery.discover(signal());
    expect(dangling).toHaveLength(2);
    expect(mapped(dangling, path.join(destination, "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "main.ts"), "first");
    const created = await discovery.discover(signal());
    expect(created.map((group) => group.authority)).toEqual(
      dangling.map((group) => group.authority),
    );
    await fs.unlink(alias);
    await directoryLink(path.join(outside, "second"), alias);
    const retargeted = await discovery.discover(signal());
    expect(expectDefined(retargeted[0], "admitted observation").authority).toBe(
      expectDefined(initial[0], "admitted observation").authority,
    );
    expect(expectDefined(retargeted[1], "admitted observation").authority).toBe(
      expectDefined(dangling[1], "admitted observation").authority,
    );
    expect(mapped(retargeted, path.join(destination, "main.ts"))).toEqual([]);
    expect(mapped(retargeted, path.join(outside, "second", "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
    await fs.unlink(alias);
    expect(await discovery.discover(signal())).toHaveLength(1);
  });

  it("does not re-admit a replaced target authority, even after its last alias was removed", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    const boundary = path.join(outside, "boundary");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    const alias = path.join(cwd, "src", "linked");
    await directoryLink(path.join(boundary, "source"), alias);
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    await discovery.discover(signal());
    await fs.unlink(alias);
    await discovery.discover(signal());
    await fs.rename(boundary, boundary + "-retired");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await directoryLink(path.join(boundary, "source"), alias);
    await expect(discovery.discover(signal())).rejects.toThrow();
  });

  it("keeps a symbolic parent of a declared destination observable", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(outside, "actual", "deep"), { recursive: true });
    await directoryLink(path.join(outside, "actual"), path.join(outside, "alias"));
    await directoryLink(path.join(outside, "alias", "deep"), path.join(cwd, "src", "linked"));
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    const groups = await discovery.discover(signal());
    expect(mapped(groups, path.join(outside, "alias"))).toContain(path.join(cwd, "src", "linked"));
    expect(mapped(groups, path.join(outside, "actual", "deep", "main.ts"))).toContain(
      path.join(cwd, "src", "linked", "main.ts"),
    );
  });
});
