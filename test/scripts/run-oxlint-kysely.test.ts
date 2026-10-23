import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const consumer = "src/state/consumer.ts";
const coreConfig = "config/tsconfig/oxlint.core.json";
const output = ".artifacts/kysely/openclaw-state-db.generated.ts";

function createLintFixture() {
  const root = tempDirs.make("oxlint-kysely-");
  const file = (name: string) => path.join(root, name);
  fs.mkdirSync(file(".git"));
  installDistArtifactScripts(root, ["run-oxlint.mjs", "run-oxlint.mts", "run-oxlint-shards.mts"], {
    compiler: false,
    dependencies: "tsx @openclaw/fs-safe json5 p-map kysely oxlint oxlint-tsgolint".split(" "),
  });
  fs.symlinkSync(
    path.resolve("node_modules/.bin"),
    file("node_modules/.bin"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), content);
  };
  const json = (name: string, value: unknown) => write(name, JSON.stringify(value));
  json("package.json", { type: "module" });
  json("tsconfig.json", { compilerOptions: { strict: true, types: [], module: "nodenext" } });
  write(coreConfig, '{"extends":"../../tsconfig.json"}');
  json(".oxlintrc.json", {
    plugins: ["typescript"],
    categories: { correctness: "off" },
    rules: { "typescript/no-redundant-type-constituents": "error" },
  });
  for (const name of ["state", "agent"]) {
    write(
      "src/state/openclaw-" + name + "-schema.sql",
      "CREATE TABLE records (title TEXT NOT NULL);",
    );
  }
  write(
    "src/state/openclaw-state-db.generated.ts",
    'export type * from "../../.artifacts/kysely/openclaw-state-db.generated.js";',
  );
  write(
    consumer,
    'import type { DB } from "./openclaw-state-db.generated.js"; export type Row = DB["records"] | null;',
  );
  return {
    file,
    write,
    exists: (name: string) => fs.existsSync(file(name)),
    run: (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          OPENCLAW_CI_STATIC_EVIDENCE: "0",
          OPENCLAW_OXLINT_SKIP_PREPARE: "0",
          ...env,
        },
      }),
  };
}

const direct = ["scripts/run-oxlint.mjs", "--tsconfig", coreConfig, consumer];
const striped = [
  "--import",
  "./scripts/tsx.mjs",
  "scripts/run-oxlint-shards.mts",
  "--only=core",
  "--split-core",
  "--core-stripe=1/5",
  "--files-json",
  JSON.stringify([consumer]),
  "--threads=1",
];

describe("typed lint Kysely prerequisites", () => {
  it.each([
    { name: "direct", args: direct, sparse: false },
    { name: "striped", args: striped, sparse: false },
    { name: "sparse direct", args: direct, sparse: true },
    { name: "sparse striped", args: striped, sparse: true },
    { name: "invalid direct", args: direct, invalid: true },
    { name: "invalid striped", args: striped, invalid: true },
  ])(
    "requires valid prepared declarations for $name core lint without plugin artifacts",
    ({ args, sparse = false, invalid = false }) => {
      const fixture = createLintFixture();
      const agentProjection = ".artifacts/kysely/openclaw-agent-db.generated.ts";
      if (sparse) {
        fs.unlinkSync(fixture.file("src/state/openclaw-agent-schema.sql"));
        fixture.write(agentProjection, "export interface Stale {}\n");
      }
      if (invalid) {
        fixture.write("src/state/openclaw-state-schema.sql", "not valid SQL");
        fixture.write(consumer, "export const valid = true;\n");
      }
      const result = fixture.run(args);
      expect(result.status, result.stdout + result.stderr).toBe(invalid ? 1 : 0);
      if (invalid) {
        expect(result.stdout + result.stderr).toContain("syntax error");
        expect(fixture.exists(".artifacts/kysely")).toBe(false);
        return;
      }
      expect(fs.readFileSync(fixture.file(output), "utf8")).toContain("title: string;");
      expect(fixture.exists(agentProjection)).toBe(!sparse);
      expect(fixture.exists(".artifacts/extension-package-boundary")).toBe(false);
    },
  );

  it("leaves preparation to skip-prepare callers and skips syntax-only and metadata commands", () => {
    const fixture = createLintFixture();
    const skipped = fixture.run(direct, { OPENCLAW_OXLINT_SKIP_PREPARE: "1" });
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(1);
    expect(skipped.stdout).toContain("no-redundant-type-constituents");
    for (const args of [
      ["scripts/run-oxlint.mjs", "--version"],
      [...direct, "--openclaw-focused-config"],
      [...striped, "--openclaw-focused-config"],
    ]) {
      const result = fixture.run(args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(fixture.exists(output)).toBe(false);
    }
  });
});
