import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderDocsHeadingMap } from "../../scripts/docs-list.js";
import { restorePrepackArtifacts } from "../../scripts/openclaw-postpack.mjs";
import { preparePackageChangelog } from "../../scripts/package-changelog.mjs";
import { preparePackageDocsMap, restorePackageDocsMap } from "../../scripts/package-docs-map.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceChangelog =
  "# Changelog\n\n## 2026.8.1\n- Current release notes with enough detail.\n\n## 2026.7.1\n- Previous release notes with enough detail.\n";

let root: string;
const map = "docs/docs_map.md";
const receipt = ".artifacts/package-docs-map/receipt.json";
const backup = ".artifacts/package-changelog/CHANGELOG.md.prepack-backup";
const file = (name: string) => path.join(root, name);
const read = (name = map) => readFileSync(file(name), "utf8");
const write = (name: string, bytes: string) => writeFileSync(file(name), bytes);
const exists = (name: string) => existsSync(file(name));
const generatedMap = () => renderDocsHeadingMap(file("docs"));
const prepare = () => preparePackageDocsMap(root);
const restore = () => restorePrepackArtifacts(root);
const prepareArtifacts = async () => {
  await prepare();
  await preparePackageChangelog(root);
};
beforeEach(() => {
  root = tempDirs.make("openclaw-package-docs-map-");
  mkdirSync(file("docs"));
  write("docs/page.md", "# Package docs\n");
  write("package.json", '{"name":"openclaw","version":"2026.8.1"}\n');
  write("CHANGELOG.md", sourceChangelog);
});
it.each(["source stub", "generated map"])(
  "serializes preparations starting from a %s",
  async (initialMap) => {
    const original = initialMap === "generated map" ? generatedMap() : "# Docs map source\n";
    write(map, original);
    const results = await Promise.allSettled([prepare(), prepare()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: {
        code: "PACKAGE_DOCS_MAP_ACTIVE",
        message: expect.stringContaining("node scripts/openclaw-postpack.mjs"),
      },
    });
    expect(read()).toBe(generatedMap());
    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(read()).toBe(original);
  },
);
it("refuses to remove a transient map changed after prepack", async () => {
  await prepare();
  write(map, "operator change\n");
  await expect(restorePackageDocsMap(root)).rejects.toThrow("changed after prepack");
  expect(read()).toBe("operator change\n");
});
it("keeps the lifecycle lock until interrupted changelog state is restored", async () => {
  const stub = "# Docs map source\n";
  write(map, stub);
  await prepareArtifacts();
  const packagedChangelog = read("CHANGELOG.md");
  write("CHANGELOG.md", "operator change\n");
  await expect(restore()).rejects.toThrow("changed since the backup");
  expect([exists(receipt), exists(backup), read()]).toEqual([true, true, generatedMap()]);
  write("CHANGELOG.md", packagedChangelog);
  await expect(restore()).resolves.toBeUndefined();
  expect([read("CHANGELOG.md"), read(), exists(backup), exists(receipt)]).toEqual([
    sourceChangelog,
    stub,
    false,
    false,
  ]);
});
it.each([".openclaw-lifecycle-pending", "dist/openclaw-install-guard"])(
  "retains the lifecycle lock when %s cannot be removed",
  async (relativePath) => {
    const markerPath = file(relativePath);
    await prepareArtifacts();
    mkdirSync(markerPath, { recursive: true });
    writeFileSync(path.join(markerPath, "retain"), "filesystem fault fixture\n");
    await expect(restore()).rejects.toMatchObject({ code: "ERR_FS_EISDIR" });
    expect(exists(receipt)).toBe(true);
    await expect(prepare()).rejects.toMatchObject({ code: "PACKAGE_DOCS_MAP_ACTIVE" });
    rmSync(markerPath, { recursive: true });
    await restore();
    expect([exists(receipt), read("CHANGELOG.md")]).toEqual([false, sourceChangelog]);
  },
);
