import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureKyselyTypes } from "../../scripts/generate-kysely-types.mts";
import { collectPackageDistImportErrors } from "../../scripts/lib/package-dist-imports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const entrypoints = [
  "scripts/generate-kysely-types.mts",
  "scripts/prepare-git-hooks.mjs",
  "scripts/prepare-native-protocol.mjs",
];
const schema = `
CREATE TABLE records (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, payload BLOB,
  count INTEGER NOT NULL DEFAULT 0, ratio REAL,
  computed TEXT GENERATED ALWAYS AS (title) VIRTUAL
);
CREATE TABLE links (record_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (record_id, tag));`;

function createSchemaFixture() {
  const root = tempDirs.make("kysely-types-");
  fs.mkdirSync(path.join(root, "src/state"), { recursive: true });
  const schemas = ["openclaw-state", "openclaw-agent"].map((name) =>
    path.join(root, "src/state", `${name}-schema.sql`),
  );
  for (const file of schemas) {
    fs.writeFileSync(file, schema);
  }
  const output = path.join(root, ".artifacts/kysely/openclaw-state-db.generated.ts");
  return {
    schemas,
    output,
    agentOutput: path.join(root, ".artifacts/kysely/openclaw-agent-db.generated.ts"),
    stamp: path.join(root, ".artifacts/kysely/inputs.sha256"),
    read: (file = output) => fs.readFileSync(file, "utf8"),
    generate: (verify = false, options: { allowPartialCheckout?: boolean } = {}) =>
      ensureKyselyTypes(root, verify, options),
  };
}

it("packages a runnable generator closure through the published file policy", () => {
  const root = tempDirs.make("kysely-package-");
  for (const file of [
    "package.json",
    ...entrypoints,
    "scripts/runtime-postbuild-shared.mjs",
    "src/infra/directory-walk.ts",
    "scripts/lib/direct-run.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, ".state") };
  const runCommand = (command: string, args: string[], cwd = root) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8" });
  const packed = runCommand(process.execPath, [
    path.resolve("node_modules/npm/bin/npm-cli.js"),
    "pack",
    "--ignore-scripts",
    "--json",
    "--offline",
    "--cache",
    path.join(root, "cache"),
  ]);
  expect(packed.status, packed.stderr).toBe(0);
  const inventoryByName = JSON.parse(packed.stdout) as Record<
    string,
    { filename: string; files: Array<{ path: string }> }
  >;
  const inventory = inventoryByName.openclaw;
  if (!inventory) {
    throw new Error("npm pack did not return the openclaw inventory");
  }
  const unpacked = path.join(root, "unpacked");
  fs.mkdirSync(unpacked);
  const extracted = runCommand("tar", [
    "-xzf",
    path.join(root, inventory.filename),
    "-C",
    unpacked,
  ]);
  expect(extracted.status, extracted.stderr).toBe(0);
  const packageRoot = path.join(unpacked, "package");
  expect(
    collectPackageDistImportErrors({
      files: inventory.files.map((file) => file.path),
      readText: (file: string) => fs.readFileSync(path.join(packageRoot, file), "utf8"),
    }),
  ).toEqual([]);
  const run = (file: string) =>
    runCommand(process.execPath, [path.join(packageRoot, file)], packageRoot);
  for (const file of entrypoints) {
    const result = run(file);
    expect(result.status, result.stderr).toBe(0);
  }
});

it("retires omitted sparse projections and still requires complete generation", async () => {
  const { schemas, output, agentOutput, stamp, read, generate } = createSchemaFixture();
  await generate();
  fs.unlinkSync(schemas[1]!);
  await generate(false, { allowPartialCheckout: true });
  expect(read()).toContain("export interface Records");
  expect(fs.existsSync(agentOutput)).toBe(false);
  await expect(generate()).rejects.toThrow("openclaw-agent-schema.sql");
  await expect(generate(true, { allowPartialCheckout: true })).rejects.toThrow(
    "openclaw-agent-schema.sql",
  );
  fs.writeFileSync(schemas[1]!, `${schema}\nALTER TABLE records ADD COLUMN restored TEXT;`);
  await generate();
  expect(read(agentOutput)).toContain("  restored: string | null;");
  for (const source of schemas) {
    fs.unlinkSync(source);
  }
  await generate(false, { allowPartialCheckout: true });
  expect([output, agentOutput, stamp].some(fs.existsSync)).toBe(false);
});

it("derives ordered tables, nullability, defaults and composite keys from SQL", async () => {
  const { schemas, read, generate } = createSchemaFixture();
  await generate();
  const declarations = read();
  expect(declarations).toContain('import type { ColumnType } from "kysely";');
  expect(declarations.slice(declarations.indexOf("export type")).replace(/\s+/gu, " ").trim()).toBe(
    "export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> " +
      "? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>; " +
      "export interface Links { record_id: number; tag: string; } " +
      "export interface Records { count: Generated<number>; id: Generated<number>; " +
      "payload: Uint8Array | null; ratio: number | null; title: string; } " +
      "export interface DB { links: Links; records: Records; }",
  );
  const statements = schema.split(";").filter((statement) => statement.trim());
  fs.writeFileSync(schemas[0]!, `${statements.toReversed().join(";")};`);
  await generate();
  expect(read()).toBe(declarations);
});

it("skips unchanged inputs and repairs missing, changed and stale projections", async () => {
  const { schemas, output, stamp, read, generate } = createSchemaFixture();
  await Promise.all([generate(), generate()]);
  fs.utimesSync(stamp, 1, 1);
  fs.utimesSync(output, 1, 1);
  await generate();
  expect([stamp, output].map((file) => fs.statSync(file).mtimeMs)).toEqual([1000, 1000]);

  fs.writeFileSync(schemas[0]!, `${schema}\nALTER TABLE records ADD COLUMN enabled INTEGER;`);
  const expectRepair = async () => {
    await expect(generate(true)).rejects.toThrow("is out of date");
    await generate();
    expect(read()).toContain("  enabled: number | null;");
  };
  await expectRepair();
  await expect(generate(true)).resolves.toBeUndefined();

  fs.writeFileSync(output, "corrupt");
  await expectRepair();
  fs.unlinkSync(output);
  await generate();
  expect(read()).toContain("  enabled: number | null;");
});
