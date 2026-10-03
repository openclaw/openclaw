import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateInstalledPackageBudget,
  measureInstalledPackageTree,
} from "../../scripts/check-openclaw-installed-package-budget.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("installed package tree budget", () => {
  // Published updaters (2026.9.3-2026.9.7) charge npm's hidden lockfile bytes too.
  it("counts installed paths and every regular file's bytes without following links", async () => {
    const root = tempDirs.make("openclaw-installed-budget-");
    const outside = tempDirs.make("openclaw-installed-budget-external-");
    writeFileSync(path.join(outside, "not-in-package"), "outside bytes");
    const manifest = '{"name":"openclaw","version":"1.2.3"}';
    writeFileSync(path.join(root, "package.json"), manifest);
    const files = [
      [".package-lock.json", 7],
      ["docs/readme.md", 11],
      ["dist/chunks/a.js", 13],
      ["dist/runtime.js", 17],
      ["node_modules/.package-lock.json", 100],
      ["node_modules/x/index.js", 19],
      ["node_modules/x/node_modules/.package-lock.json", 101],
      ["node_modules/@scope/pkg/index.js", 29],
      ["node_modules/@scope/pkg/node_modules/y/index.js", 23],
    ] as const;
    for (const [relative, bytes] of files) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "x".repeat(bytes));
    }
    mkdirSync(path.join(root, "node_modules/.bin"));
    symlinkSync(outside, path.join(root, "dist/external"), "junction");
    symlinkSync(path.join(outside, "not-in-package"), path.join(root, "node_modules/.bin/tool"));
    linkSync(path.join(root, ".package-lock.json"), path.join(root, "docs/copy"));

    const measurement = await measureInstalledPackageTree(root);
    expect(measurement).toEqual({
      name: "openclaw",
      version: "1.2.3",
      entries: 25,
      bytes: Buffer.byteLength(manifest) + 327,
      // Container directories own one entry; package buckets include their nested dependencies.
      // dist itself owns one entry, while direct files and links share dist/*.
      contributors: [
        { bucket: "node_modules/@scope/pkg", entries: 5, bytes: 52 },
        { bucket: "node_modules/x", entries: 4, bytes: 120 },
        { bucket: "docs", entries: 3, bytes: 18 },
        { bucket: "dist/*", entries: 2, bytes: 17 },
        { bucket: "dist/chunks", entries: 2, bytes: 13 },
        { bucket: "node_modules/.bin", entries: 2, bytes: 0 },
        { bucket: ".package-lock.json", entries: 1, bytes: 7 },
        { bucket: "dist", entries: 1, bytes: 0 },
        { bucket: "node_modules", entries: 1, bytes: 0 },
        { bucket: "node_modules/.package-lock.json", entries: 1, bytes: 100 },
        { bucket: "node_modules/@scope", entries: 1, bytes: 0 },
        { bucket: "package.json", entries: 1, bytes: Buffer.byteLength(manifest) },
      ],
    });
  });

  it.each([undefined, "{", '{"version":123}'])(
    "rejects an invalid manifest: %s",
    async (manifest) => {
      const root = tempDirs.make("openclaw-installed-budget-invalid-");
      if (manifest !== undefined) {
        writeFileSync(path.join(root, "package.json"), manifest);
      }
      await expect(measureInstalledPackageTree(root)).rejects.toThrow(
        "an installed OpenClaw package root such as <prefix>/lib/node_modules/openclaw",
      );
    },
  );

  it("rejects a file or symlink root, including a trailing separator", async () => {
    const root = tempDirs.make("openclaw-installed-budget-root-");
    const manifest = path.join(root, "package.json");
    writeFileSync(manifest, '{"version":"1.2.3"}');
    const link = path.join(tempDirs.make("openclaw-installed-budget-link-"), "package");
    symlinkSync(root, link, "junction");
    for (const invalidRoot of [manifest, link, `${link}${path.sep}`]) {
      await expect(measureInstalledPackageTree(invalidRoot)).rejects.toThrow(
        "root must be a real directory",
      );
    }
  });

  it.each([
    { entries: 4, bytes: 9, exceeded: [] },
    { entries: 5, bytes: 10, exceeded: [] },
    { entries: 6, bytes: 10, exceeded: ["entries"] },
    { entries: 5, bytes: 11, exceeded: ["bytes"] },
    { entries: 6, bytes: 11, exceeded: ["entries", "bytes"] },
  ])(
    "evaluates $entries entries and $bytes bytes against inclusive budgets",
    ({ entries, bytes, exceeded }) => {
      expect(evaluateInstalledPackageBudget({ entries, bytes }, { entries: 5, bytes: 10 })).toEqual(
        exceeded,
      );
    },
  );
});
