import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";

const operations: Array<{ close(): void }> = [];
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    operations.splice(0).forEach((operation) => operation.close());
    cleanup();
  }),
);
async function fixture() {
  // Executable-bit inference is not under test; require a declarative setup recipe.
  const f = await createProjectPreparationFixture(
    dirs.make("project-snapshot-"),
    undefined,
    false,
    {
      ".devcontainer/devcontainer.json": JSON.stringify({
        onCreateCommand: "printf 'prepared output\n' > prepared-output.txt",
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
  for (const ref of new Set([prepared.sourceManifestRef, prepared.preparedManifestRef])) {
    await fs.writeFile(
      path.join(root, "manifests", ref.slice(7) + ".memo"),
      "retained optional hint",
    );
  }
  return { ...f, operation, prepared, root, oldSeed, oldManifest, oldMemo };
}

it("normalizes only snapshot publication, preserving the verified current project", async () => {
  const f = await fixture();
  const manifests = path.join(f.root, "manifests");
  const retained = new Map(
    await Promise.all(
      (await fs.readdir(manifests))
        .filter((name) => !name.startsWith("f".repeat(64)))
        .map(async (name) => [name, await fs.readFile(path.join(manifests, name))] as const),
    ),
  );
  // The real preparation owner emitted these artifacts; no synthetic current memo fixtures.
  expect([...retained.keys()].filter((name) => name.endsWith(".json"))).toHaveLength(2);
  expect([...retained.keys()].filter((name) => name.endsWith(".memo"))).toHaveLength(2);
  await f.operation.project.inspectPreparedWorkspace!(f);
  expect(await fs.readFile(f.oldManifest, "utf8")).toContain("obsolete");
  await f.operation.project.prepareSnapshot!(f);
  await expect(fs.stat(f.oldSeed)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(f.oldManifest)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(f.oldMemo)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(manifests)).toSorted()).toEqual([...retained.keys()].toSorted());
  for (const [name, bytes] of retained) {
    expect(await fs.readFile(path.join(manifests, name))).toEqual(bytes);
  }
  expect(await fs.readFile(path.join(f.prepared.workspaceDir, "input.txt"), "utf8")).toBe(
    "prepared base\n",
  );
  expect((await fs.readdir(path.join(f.root, "manifests"))).toSorted()).toEqual(
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
