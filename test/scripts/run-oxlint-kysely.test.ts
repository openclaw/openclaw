import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createLintFixture() {
  const root = tempDirs.make("oxlint-kysely-");
  fs.mkdirSync(path.join(root, ".git"));
  installDistArtifactScripts(root, ["run-oxlint.mjs", "run-oxlint.mts", "run-oxlint-shards.mts"], {
    compiler: false,
    dependencies: [
      "tsx",
      "@openclaw/fs-safe",
      "json5",
      "p-map",
      "kysely",
      "oxlint",
      "oxlint-tsgolint",
    ],
  });
  fs.symlinkSync(
    path.resolve("node_modules/.bin"),
    path.join(root, "node_modules/.bin"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true, types: [], module: "nodenext" } }),
  );
  write("config/tsconfig/oxlint.core.json", '{"extends":"../../tsconfig.json"}');
  write(
    ".oxlintrc.json",
    JSON.stringify({
      plugins: ["typescript"],
      categories: { correctness: "off" },
      rules: { "typescript/no-redundant-type-constituents": "error" },
    }),
  );
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
    "src/state/consumer.ts",
    'import type { DB } from "./openclaw-state-db.generated.js"; export type Row = DB["records"] | null;',
  );
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
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
    });
  return {
    root,
    run,
    write,
    output: path.join(root, ".artifacts/kysely/openclaw-state-db.generated.ts"),
  };
}

const direct = [
  "scripts/run-oxlint.mjs",
  "--tsconfig",
  "config/tsconfig/oxlint.core.json",
  "src/state/consumer.ts",
];
const striped = [
  "--import",
  "./scripts/tsx.mjs",
  "scripts/run-oxlint-shards.mts",
  "--only=core",
  "--split-core",
  "--core-stripe=1/5",
  "--files-json",
  '["src/state/consumer.ts"]',
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
        fs.unlinkSync(path.join(fixture.root, "src/state/openclaw-agent-schema.sql"));
        fixture.write(agentProjection, "export interface Stale {}\n");
      }
      if (invalid) {
        fixture.write("src/state/openclaw-state-schema.sql", "not valid SQL");
        fixture.write("src/state/consumer.ts", "export const valid = true;\n");
      }
      expect(fs.existsSync(fixture.output)).toBe(false);
      const result = fixture.run(args);
      if (invalid) {
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout + result.stderr).toContain("syntax error");
        expect(fs.existsSync(path.join(fixture.root, ".artifacts/kysely"))).toBe(false);
        return;
      }
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.output, "utf8")).toContain("title: string;");
      expect(fs.existsSync(path.join(fixture.root, agentProjection))).toBe(!sparse);
      expect(fs.existsSync(path.join(fixture.root, ".artifacts/extension-package-boundary"))).toBe(
        false,
      );
    },
  );

  it.each([
    { name: "direct", args: direct },
    { name: "striped", args: striped },
  ])("prepares browser public declarations before $name typed lint", ({ args }) => {
    const fixture = createLintFixture();
    const declaration = ".artifacts/extension-package-boundary/plugins/github/control-ui-api.d.ts";
    fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          module: "nodenext",
          paths: { "@openclaw/github/control-ui-api.js": ["./" + declaration] },
        },
      }),
    );
    fixture.write(
      "src/state/consumer.ts",
      'import type { View } from "@openclaw/github/control-ui-api.js"; export type Row = View | null;',
    );
    // Native emit has separate proof; this fixture checks the two lint owners' ordering.
    fixture.write(
      "scripts/prepare-extension-package-boundary-artifacts.mts",
      `
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--mode=control-ui")) {
  fs.mkdirSync(path.dirname(${JSON.stringify(declaration)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(declaration)}, "export type View = string;\\n");
}
`,
    );
    const missing = fixture.run(direct, { OPENCLAW_OXLINT_SKIP_PREPARE: "1" });
    expect(missing.status, missing.stdout + missing.stderr).toBe(1);
    expect(missing.stdout).toContain("no-redundant-type-constituents");
    const prepared = fixture.run(args);
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  });

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
      expect(fs.existsSync(fixture.output)).toBe(false);
    }
  });
});
