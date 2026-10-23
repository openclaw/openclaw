import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmJsonEntries } from "../../scripts/lib/npm-json-output.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const declarationConfigs = [
  { file: "extensions/tsconfig.package-boundary.paths.json", prefix: "../" },
  { file: "extensions/xai/tsconfig.json", prefix: "../../" },
] as const;
const outputFiles = [
  "package.json",
  "packages/plugin-sdk/package.json",
  ...declarationConfigs.map(({ file }) => file),
];
const entryList = "scripts/lib/plugin-sdk-entrypoints.json";
const privateList = "scripts/lib/plugin-sdk-private-local-only-subpaths.json";
const syncScript = "scripts/sync-plugin-sdk-exports.mts";
const loaderArgs = ["--import", path.join(repoRoot, "scripts/tsx.mjs")];
const fixtureFiles = [
  "dist/",
  "assets/",
  "!assets/internal.txt",
  "!dist/plugin-sdk/nested/internal.d.ts",
  ...["*", "?", "[ab]", "{a,b}", "@(a|b)"].map((glob) => `!dist/plugin-sdk/owner-${glob}.js`),
  "!dist/**/*.map",
  "!dist/plugin-sdk/.tsbuildinfo",
  "!dist/plugin-sdk/qa-lab.*",
  "!dist/plugin-sdk/owner_entry.json",
];
const literalEntries = ["private-entry", "private_entry", "Private.entry-Ü"];

function declarationPaths(prefix: string, entries: string[] = []) {
  const declaration = `${prefix}packages/plugin-sdk/dist/src/plugin-sdk/`;
  return {
    "openclaw/plugin-sdk/*": [`${prefix}dist/plugin-sdk/*.d.ts`],
    "openclaw/plugin-sdk/custom": [`${declaration}custom.d.ts`, "./override.d.ts"],
    ...Object.fromEntries(
      entries.map((entry) => [`openclaw/plugin-sdk/${entry}`, [`${declaration}${entry}.d.ts`]]),
    ),
  };
}

function publicExport(entry: string, privateEntry = false) {
  return {
    ...(!privateEntry && { types: `./dist/plugin-sdk/${entry}.d.ts` }),
    default: `./dist/plugin-sdk/${entry}.js`,
  };
}

function expectRegistration(root: string, publicEntries: string[], privateEntries: string[]) {
  expect(readPackage(root).exports).toEqual({
    ".": "./index.js",
    ...Object.fromEntries([
      ...publicEntries.map((entry) => [`./plugin-sdk/${entry}`, publicExport(entry)]),
      ...privateEntries
        .filter((entry) => entry !== "test-fixtures")
        .map((entry) => [`./plugin-sdk/${entry}`, publicExport(entry, true)]),
    ]),
  });
  for (const { file, prefix } of declarationConfigs) {
    const config: { compilerOptions: { paths: Record<string, string[]> } } = JSON.parse(
      fs.readFileSync(path.join(root, file), "utf8"),
    );
    expect(config.compilerOptions.paths).toEqual(declarationPaths(prefix, privateEntries));
  }
}

function writeJson(root: string, file: string, value: unknown) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function readOutputs(root: string) {
  return outputFiles.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

function readPackage(root: string): { exports: Record<string, unknown>; files: string[] } {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function createFixture(inventory?: { entries: string[]; privateEntries: string[] }) {
  const root = tempDirs.make("openclaw-sdk-registration-");
  for (const file of [
    syncScript,
    "scripts/lib/plugin-sdk-entries.mts",
    entryList,
    privateList,
    "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
    "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
    ...outputFiles,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "packages/plugin-sdk/src"), { recursive: true });
  if (inventory) {
    writeJson(root, entryList, inventory.entries);
    writeJson(root, privateList, inventory.privateEntries);
    writeJson(root, "package.json", {
      name: "sdk-registration-fixture",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.js" },
      files: fixtureFiles,
    });
    writeJson(root, "packages/plugin-sdk/package.json", { exports: {} });
    for (const { file, prefix } of declarationConfigs) {
      writeJson(root, file, { compilerOptions: { paths: declarationPaths(prefix) } });
    }
  } else {
    // Registration reads facade names, not their implementation or dependencies.
    for (const file of fs.readdirSync(path.join(repoRoot, "packages/plugin-sdk/src"))) {
      if (file.endsWith(".ts")) {
        fs.writeFileSync(path.join(root, "packages/plugin-sdk/src", file), "");
      }
    }
  }
  return root;
}

function runSync(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [...loaderArgs, path.join(root, syncScript), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function expectStableSync(root: string) {
  const synced = readOutputs(root);
  for (const args of [[], ["--check"]]) {
    const result = runSync(root, ...args);
    expect(result.status, result.stderr).toBe(0);
    expect(readOutputs(root)).toEqual(synced);
  }
}

describe("plugin SDK registration CLI", () => {
  it("detects files-only drift without writing, repairs it and stays byte-idempotent", () => {
    const root = createFixture();
    const original = readOutputs(root);
    expect(runSync(root).status).toBe(0);
    expect(readOutputs(root)).toEqual(original);
    const manifest = readPackage(root);
    const exclusion = "!dist/plugin-sdk/gateway-config-runtime.d.ts";
    manifest.files = manifest.files.filter((file) => file !== exclusion);
    writeJson(root, "package.json", manifest);
    const before = readOutputs(root);

    const result = runSync(root, "--check");

    expect(readOutputs(root)).toEqual(before);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("package.json out of sync");
    expect(result.stderr).toContain("pnpm plugin-sdk:sync-exports");
    expect(result.stdout).not.toContain("synced");
    for (const file of outputFiles.slice(1)) {
      expect(result.stderr).not.toContain(file);
    }
    expect(runSync(root).status).toBe(0);
    expect(readPackage(root)).toEqual({ ...manifest, files: [...manifest.files, exclusion] });
    expect(readOutputs(root).slice(1)).toEqual(before.slice(1));
    expectStableSync(root);
  });

  it("packs literal entry names without private types or test-only exports", () => {
    const root = createFixture({
      entries: ["public-entry", ...literalEntries, "test-fixtures"],
      privateEntries: [...literalEntries, "test-fixtures", "qa-lab"],
    });
    const included = [
      "assets/public.txt",
      "dist/plugin-sdk/nested/public.d.ts",
      "dist/plugin-sdk/owner-extra.d.ts",
      "dist/plugin-sdk/public-entry.js",
      "dist/plugin-sdk/public-entry.d.ts",
      ...literalEntries.map((entry) => `dist/plugin-sdk/${entry}.js`),
    ];
    const excluded = [
      "assets/internal.txt",
      "dist/plugin-sdk/nested/internal.d.ts",
      "dist/plugin-sdk/owner-extra.js",
      "dist/plugin-sdk/public-entry.js.map",
      "dist/plugin-sdk/.tsbuildinfo",
      "dist/plugin-sdk/qa-lab.js",
      "dist/plugin-sdk/owner_entry.json",
      ...literalEntries.map((entry) => `dist/plugin-sdk/${entry}.d.ts`),
      "dist/plugin-sdk/test-fixtures.js",
      "dist/plugin-sdk/test-fixtures.d.ts",
    ];
    for (const file of [...included, ...excluded]) {
      writeJson(root, file, {});
    }
    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    const npm = resolveNpmRunner({ npmArgs: ["pack", "--dry-run", "--json", "--ignore-scripts"] });
    const packed = spawnSync(npm.command, npm.args, { ...npm, cwd: root, encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
    const packs = resolveNpmJsonEntries(JSON.parse(packed.stdout)) as {
      files: { path: string }[];
    }[];
    expect(packs).toHaveLength(1);
    expect(packs.flatMap((pack) => pack.files.map((file) => file.path)).toSorted()).toEqual(
      ["package.json", ...included].toSorted(),
    );
    expect(readPackage(root).files).toEqual([
      ...fixtureFiles,
      ...literalEntries.map((entry) => `!dist/plugin-sdk/${entry}.d.ts`),
      "!dist/plugin-sdk/test-fixtures.d.ts",
      "!dist/plugin-sdk/test-fixtures.js",
    ]);
    expectRegistration(root, ["public-entry"], [...literalEntries, "test-fixtures"]);
    expectStableSync(root);
  });

  it("prunes generated aliases and exclusions when private entries become public, then re-registers them", () => {
    const formerEntries = literalEntries.map((entry) => `former-${entry}`);
    const root = createFixture({
      entries: ["private-entry", "test-fixtures", ...formerEntries],
      privateEntries: ["private-entry", "test-fixtures", ...formerEntries],
    });
    expect(runSync(root).status).toBe(0);
    writeJson(root, privateList, ["private-entry", "test-fixtures"]);
    const manifest = readPackage(root);
    const retained = [
      "!dist/plugin-sdk/test-fixtures.js",
      ...fixtureFiles,
      "!dist/plugin-sdk/private-entry.d.ts",
      "!dist/plugin-sdk/test-fixtures.d.ts",
    ];
    manifest.files = [
      ...retained,
      "!dist/plugin-sdk/private-entry.js",
      "!dist/plugin-sdk/private-entry.d.ts",
      ...formerEntries.flatMap((entry) => [
        `!dist/plugin-sdk/${entry}.js`,
        `!dist/plugin-sdk/${entry}.d.ts`,
      ]),
    ];
    writeJson(root, "package.json", manifest);

    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    expect(readPackage(root).files).toEqual(retained);
    expectRegistration(root, formerEntries, ["private-entry", "test-fixtures"]);
    expectStableSync(root);
    writeJson(root, privateList, ["private-entry", "test-fixtures", ...formerEntries]);
    expect(runSync(root).status).toBe(0);
    expect(readPackage(root).files).toEqual([
      ...retained,
      ...formerEntries.map((entry) => `!dist/plugin-sdk/${entry}.d.ts`),
    ]);
    expectRegistration(root, [], ["private-entry", "test-fixtures", ...formerEntries]);
    expectStableSync(root);
  });

  it("rejects stale facade files before any writes", () => {
    const root = createFixture({ entries: ["private-entry"], privateEntries: ["private-entry"] });
    fs.writeFileSync(path.join(root, "packages/plugin-sdk/src/stale.ts"), "");
    const before = readOutputs(root);

    const result = runSync(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/plugin-sdk/src/stale.ts does not match any plugin SDK entrypoint",
    );
    expect(readOutputs(root)).toEqual(before);
  });
});
