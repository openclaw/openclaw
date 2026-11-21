import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

const operations: Array<{ close(): void }> = [];
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    operations.splice(0).forEach((operation) => operation.close());
    cleanup();
  }),
);
async function fixture(containerEnv: Record<string, string> = {}) {
  const f = await createProjectPreparationFixture(
    dirs.make("project-snapshot-"),
    undefined,
    false,
    {
      ".devcontainer/devcontainer.json": JSON.stringify({
        containerEnv,
        onCreateCommand: "printf 'prepared output\n' > prepared-output.txt",
        updateContentCommand: "printf 'prepared output\n' > prepared-output.txt",
      }),
    },
  );
  const operation = await f.preparedOperation();
  operations.push(operation);
  const result = await operation.project.prepare(f);
  expect(result.recipePreparation).toMatchObject({ source: "devcontainer" });
  expect(result.recipePreparation?.failure).toBeUndefined();
  const prepared = result.preparedWorkspace!;
  expect(await fs.readFile(path.join(prepared.workspaceDir, "prepared-output.txt"), "utf8")).toBe(
    "prepared output\n",
  );
  const root = path.join(f.home, ".openclaw-worker");
  const oldSeed = path.join(root, "git-seeds", "gateway", "e".repeat(64));
  const oldManifest = path.join(root, "manifests", "f".repeat(64) + ".json");
  await fs.mkdir(oldSeed);
  await fs.writeFile(path.join(oldSeed, "obsolete"), "previous cache");
  await fs.writeFile(oldManifest, "obsolete manifest need not be scanned");
  const oldMemo = oldManifest.replace(/json$/, "memo");
  await fs.writeFile(oldMemo, "obsolete memo need not be scanned");
  return { ...f, operation, prepared, root, oldSeed, oldManifest, oldMemo };
}

async function refreshedFixture() {
  const f = await fixture();
  f.operation.close();
  await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
  await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
  const project = (await prepareWorkerProjectSnapshot({
    localPath: f.repository,
    namespace: "gateway",
  }))!;
  const operation = await f.preparedOperation(undefined, { project, key: "b".repeat(64) });
  operations.push(operation);
  const result = await operation.project.prepare(f);
  expect(result.recipePreparation?.failure).toBeUndefined();
  const prepared = result.preparedWorkspace!;
  expect(prepared.homeDir).toBe(f.prepared.homeDir);
  expect(prepared.sourceManifestRef).not.toBe(f.prepared.sourceManifestRef);
  expect(prepared.preparedManifestRef).not.toBe(f.prepared.preparedManifestRef);
  expect(prepared.sourceManifestRef).not.toBe(prepared.preparedManifestRef);
  return { ...f, previous: f.prepared, operation, prepared };
}

const manifestRoots = (f: Awaited<ReturnType<typeof fixture>>) =>
  [
    path.join(f.root, "manifests"),
    path.join(f.prepared.homeDir, ".openclaw-worker", "manifests"),
  ] as const;

async function records(roots: readonly string[]) {
  const result = new Map<string, unknown>();
  const visit = async (file: string): Promise<void> => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      result.set(file, ["symlink", await fs.readlink(file)]);
    } else if (stat.isDirectory()) {
      result.set(file, ["directory"]);
      for (const name of await fs.readdir(file)) {
        await visit(path.join(file, name));
      }
    } else {
      result.set(
        file,
        stat.isFile() ? ["file", stat.nlink, await fs.readFile(file)] : ["other", stat.mode],
      );
    }
  };
  for (const root of roots) {
    await visit(root);
  }
  return result;
}

it("normalizes only snapshot publication, preserving the verified current project", async () => {
  const f = await fixture();
  const manifests = path.join(f.root, "manifests");
  const retained = new Map<string, Buffer>();
  for (const root of [manifests, path.join(f.prepared.homeDir, ".openclaw-worker", "manifests")]) {
    for (const name of await fs.readdir(root)) {
      if (name === "prepared" || name.startsWith("f".repeat(64))) {
        continue;
      }
      const file = path.join(root, name);
      retained.set(file, await fs.readFile(file));
    }
  }
  // Preserve every real producer copy; canonical artifact identities do not depend on HOME.
  const names = [...new Set([...retained.keys()].map((file) => path.basename(file)))];
  expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(2);
  expect(names.filter((name) => name.endsWith(".memo"))).toHaveLength(2);
  await f.operation.project.inspectPreparedWorkspace!(f);
  expect(await fs.readFile(f.oldManifest, "utf8")).toContain("obsolete");
  await f.operation.project.prepareSnapshot!(f);
  await expect(fs.stat(f.oldSeed)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(f.oldManifest)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(f.oldMemo)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(manifests)).toSorted()).toEqual(
    [...retained.keys()]
      .filter((file) => path.dirname(file) === manifests)
      .map((file) => path.basename(file))
      .toSorted(),
  );
  for (const [file, bytes] of retained) {
    expect(await fs.readFile(file)).toEqual(bytes);
  }
  expect(await fs.readFile(path.join(f.prepared.workspaceDir, "input.txt"), "utf8")).toBe(
    "prepared base\n",
  );
  expect(names.toSorted()).toEqual(
    [...new Set([f.prepared.sourceManifestRef, f.prepared.preparedManifestRef])]
      .flatMap((ref) => [ref.slice(7) + ".json", ref.slice(7) + ".memo"])
      .toSorted(),
  );
});

it("rejects unsafe cache state before removing any obsolete artifacts", async () => {
  const f = await fixture();
  const secret = path.join(f.home, "private-fixture");
  await fs.writeFile(secret, "private fixture contents");
  for (const kind of ["unknown", "symlink", "hardlink", "memo-hardlink"] as const) {
    const entry = path.join(
      f.root,
      "manifests",
      kind === "unknown"
        ? "private-fixture"
        : "d".repeat(64) + (kind === "memo-hardlink" ? ".memo" : ".json"),
    );
    if (kind === "symlink") {
      await fs.symlink(secret, entry);
    } else if (kind === "hardlink" || kind === "memo-hardlink") {
      await fs.link(secret, entry);
    } else {
      await fs.copyFile(secret, entry);
    }
    await expect(f.operation.project.prepareSnapshot!(f), kind).rejects.toMatchObject({
      stderr: expect.stringContaining('"cacheKind":"manifests"'),
    });
    expect(await fs.readFile(f.oldManifest, "utf8")).toContain("obsolete");
    expect(await fs.readFile(secret, "utf8")).toBe("private fixture contents");
    expect((await fs.stat(f.oldSeed)).isDirectory()).toBe(true);
    await fs.unlink(entry);
  }
  const source = path.join(f.root, "manifests", f.prepared.sourceManifestRef.slice(7) + ".json");
  const bytes = await fs.readFile(source);
  await fs.writeFile(source, "corrupt retained host manifest");
  await expect(f.operation.project.prepareSnapshot!(f)).rejects.toMatchObject({
    stderr: expect.stringContaining('"cacheCheck":"verification"'),
  });
  expect(await fs.readFile(f.oldManifest, "utf8")).toContain("obsolete");
  await fs.writeFile(source, bytes);
  for (const [relative, check, kind] of [
    ["git-seeds/unexpected", "cache-inventory", "git-seeds"],
    [`prepared/gateway/${"c".repeat(64)}/unexpected`, "unapproved-entry", "prepared"],
  ] as const) {
    const entry = path.join(f.root, relative);
    await fs.mkdir(entry);
    await expect(f.operation.project.prepareSnapshot!(f)).rejects.toThrow(
      `"cacheCheck":"${check}","cacheKind":"${kind}"`,
    );
    expect((await fs.stat(f.oldSeed)).isDirectory()).toBe(true);
    expect(await fs.readFile(f.oldManifest, "utf8")).toContain("obsolete");
    await fs.rmdir(entry);
  }
  await expect(
    f.operation.project.prepareSnapshot!({
      runScript: async () => "private fixture output",
    }),
  ).rejects.toThrow(/^Project snapshot verification returned invalid JSON$/);
});

it("removes real A-to-B refresh artifacts from both HOMEs and preserves the current completion", async () => {
  const f = await refreshedFixture();
  const roots = manifestRoots(f);
  const old = [...new Set([f.previous.sourceManifestRef, f.previous.preparedManifestRef])];
  const oldMemo = path.join(roots[1], f.previous.preparedManifestRef.slice(7) + ".memo");
  expect((await fs.stat(oldMemo)).isFile()).toBe(true);
  await expect(fs.stat(oldMemo.replace(/memo$/, "json"))).rejects.toMatchObject({ code: "ENOENT" });
  const before = await records(roots);
  await f.operation.project.inspectPreparedWorkspace!(f);
  expect(await records(roots)).toEqual(before);
  await f.operation.project.prepareSnapshot!(f);
  for (const root of roots) {
    for (const ref of old) {
      for (const suffix of [".json", ".memo"]) {
        await expect(fs.stat(path.join(root, ref.slice(7) + suffix))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  }
  const after = await records(roots);
  const selected = new Set([f.prepared.sourceManifestRef, f.prepared.preparedManifestRef]);
  const completion = path.join(roots[1], "prepared");
  for (const [file, value] of before) {
    if (
      [...selected].some((ref) => path.basename(file).startsWith(ref.slice(7))) ||
      file === completion ||
      file.startsWith(completion + path.sep)
    ) {
      expect(after.get(file)).toEqual(value);
    }
  }
  expect(await fs.readFile(path.join(f.prepared.workspaceDir, "input.txt"), "utf8")).toBe(
    "changed B\n",
  );
  await f.operation.project.inspectPreparedWorkspace!(f);
});

it("rejects every cross-root hazard before deleting any host or prepared-HOME artifacts", async () => {
  const f = await refreshedFixture();
  const roots = manifestRoots(f);
  const privateRoot = path.join(f.home, "private-safety");
  await fs.mkdir(privateRoot);
  const secret = path.join(privateRoot, "secret");
  await fs.writeFile(secret, "private fixture contents");
  const seedRoot = path.join(f.root, "git-seeds", "gateway");
  const refuse = async (diagnostic: string | RegExp, extra: string[] = []) => {
    const protectedRoots = [...roots, privateRoot, ...extra];
    const before = await records(protectedRoots);
    const seeds = await fs.readdir(seedRoot);
    await expect(f.operation.project.prepareSnapshot!(f)).rejects.toMatchObject({
      stderr:
        typeof diagnostic === "string"
          ? expect.stringContaining(diagnostic)
          : expect.stringMatching(diagnostic),
    });
    expect(await records(protectedRoots)).toEqual(before);
    expect(await fs.readdir(seedRoot)).toEqual(seeds);
  };
  for (const root of roots) {
    for (const kind of [
      "unknown",
      "separator",
      "symlink",
      "hardlink",
      "memo-hardlink",
      "directory",
      "fifo",
      "selected-json",
      "selected-json-hardlink",
      "selected-memo-hardlink",
    ]) {
      const selected = (await fs.readdir(root)).find(
        (name) =>
          name.endsWith(kind.includes("memo") ? ".memo" : ".json") &&
          [f.prepared.sourceManifestRef, f.prepared.preparedManifestRef].some((ref) =>
            name.startsWith(ref.slice(7)),
          ),
      )!;
      const entry = path.join(
        root,
        kind.startsWith("selected")
          ? selected
          : kind === "unknown"
            ? "private-fixture"
            : kind === "separator"
              ? "d".repeat(64) + "xjson"
              : "d".repeat(64) + (kind === "memo-hardlink" ? ".memo" : ".json"),
      );
      const linked = path.join(privateRoot, "linked-current");
      const bytes = kind === "selected-json" ? await fs.readFile(entry) : undefined;
      if (kind.startsWith("selected") && kind.endsWith("hardlink")) {
        await fs.link(entry, linked);
      } else if (kind === "symlink") {
        await fs.symlink(secret, entry);
      } else if (kind === "hardlink" || kind === "memo-hardlink") {
        await fs.link(secret, entry);
      } else if (kind === "directory") {
        await fs.mkdir(entry);
      } else if (kind === "fifo") {
        execFileSync("mkfifo", [entry]);
      } else {
        await fs.copyFile(secret, entry);
      }
      const check =
        kind === "unknown" || kind === "separator"
          ? '"cacheCheck":"unapproved-entry","cacheKind":"manifests"'
          : kind === "selected-json"
            ? '"cacheCheck":"verification"'
            : '"cacheCheck":"cache-path","cacheKind":"manifests"';
      await refuse(check);
      if (bytes) {
        await fs.writeFile(entry, bytes);
      } else if (kind.startsWith("selected")) {
        await fs.unlink(linked);
      } else if (kind === "directory") {
        await fs.rmdir(entry);
      } else {
        await fs.unlink(entry);
      }
    }
    const backup = root + "-saved";
    await fs.rename(root, backup);
    await fs.symlink(privateRoot, root);
    await refuse(
      // The canonical inspector may reject the unsafe namespace before planning.
      /"cacheCheck":"cache-path","cacheKind":"manifests"|"cacheCheck":"verification","cacheKind":"project"/,
      [backup],
    );
    await fs.unlink(root);
    await fs.rename(backup, root);
  }
  const witness = path.join(
    roots[1],
    "prepared",
    f.prepared.sourceManifestRef.slice(7),
    f.prepared.preparedManifestRef.slice(7) + ".json",
  );
  const link = path.join(privateRoot, "linked-completion");
  await fs.link(witness, link);
  await refuse('"cacheCheck":"cache-path","cacheKind":"manifests"');
  await fs.unlink(link);
  await f.operation.project.prepareSnapshot!(f);
});

it("keeps supported recipe environments within the real preparation transport", async () => {
  const environment = Object.fromEntries(
    Array.from(
      { length: 8 },
      (_, index) => ["FIXTURE_PAYLOAD_" + index, "x".repeat(4000)] as const,
    ),
  );
  const f = await fixture(environment);
  await f.operation.project.inspectPreparedWorkspace!(f);
  await f.operation.project.prepareSnapshot!(f);
});
