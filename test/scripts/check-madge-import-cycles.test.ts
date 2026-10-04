import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

function createCheckerFixture(files: Record<string, string>, config: object = {}) {
  const root = fixtures.createTempDir("madge-import-cycles-");
  for (const directory of ["src/infra", "extensions", "ui", "scripts/lib"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of [
    "src/infra/node-compiler-policy.mjs",
    "scripts/check-madge-import-cycles.ts",
    "scripts/tsx.mjs",
    "scripts/lib/tsx-cli-shim.mjs",
    "scripts/lib/local-check-runtime.mts",
    "scripts/lib/import-cycle-graph.ts",
    "scripts/lib/native-typescript.mts",
    "scripts/lib/native-typescript-diagnostics.mts",
    "scripts/lib/ts-guard-utils.mts",
  ]) {
    fs.copyFileSync(path.resolve(file), path.join(root, file));
  }
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
        noLib: true,
        paths: { "@fixture/*": ["./src/*"] },
        ...config,
      },
    }),
  );
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

async function runChecker(root: string, signal: AbortSignal) {
  const result = await runNodeScript(
    ["--import", "./scripts/tsx.mjs", "scripts/check-madge-import-cycles.ts"],
    process.env,
    undefined,
    { cwd: root, signal, requireProcessTreeExit: process.platform !== "win32" },
  );
  if (result.error) {
    throw new Error("Madge command did not complete", { cause: result.error });
  }
  return result;
}

describe("Madge import-cycle CLI", () => {
  describe.each<{
    name: string;
    files: Record<string, string>;
    config?: object;
    status: number;
    stdout?: string;
    stderr?: string;
  }>([
    {
      name: "clean graph with dynamic imports",
      files: {
        "src/a.ts": 'export const value = 1; void import("./b.js");',
        "src/b.ts": 'import { value } from "./a.js"; export const copy = value;',
        "src/dist/ignored.ts": 'import "./ignored.js";',
      },
      status: 0,
      stdout: "Madge import cycle check: 0 cycle(s).\n",
    },
    {
      name: "alias, re-export and type-only cycle",
      files: {
        "src/a.ts": 'export { value } from "@fixture/b"; export type Value = number;',
        "src/b.ts": 'import type { Value } from "./a.js"; export const value: Value = 1;',
      },
      status: 1,
      stdout: "Madge import cycle check: 1 cycle(s).\n",
      stderr: "# cycle 1\n  src/a.ts\n  -> src/b.ts\n",
    },
    {
      name: "invalid project configuration",
      files: { "src/a.ts": "export const value = 1;" },
      config: { unknownCompilerOption: true },
      status: 1,
      stderr: "error TS5023",
    },
  ])("$name", ({ files, config, status, stdout, stderr }) => {
    it("joins its compiler and preserves diagnostics", async ({ signal }) => {
      await fixtures.run(async () => {
        const result = await runChecker(createCheckerFixture(files, config), signal);
        expect(result.status, result.stderr).toBe(status);
        if (stdout !== undefined) {
          expect(result.stdout).toBe(stdout);
        }
        if (stderr !== undefined) {
          expect(result.stderr).toContain(stderr);
        }
      });
    });
  });
});
