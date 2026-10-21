import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

function createCheckerFixture(files: Record<string, string>, config: object = {}) {
  const root = fixtures.createTempDir("madge-import-cycles-");
  for (const directory of ["src", "extensions", "ui", "scripts/lib"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of [
    "scripts/check-madge-import-cycles.ts",
    "scripts/check-import-cycles.ts",
    "scripts/tsx.mjs",
    "scripts/lib/tsx-cli-shim.mjs",
    "scripts/lib/managed-cleanup-handoff.mts",
    "scripts/lib/local-check-runtime.mts",
    "scripts/lib/import-cycle-graph.ts",
    "scripts/lib/native-typescript.mts",
    "scripts/lib/native-typescript-diagnostics.mts",
    "scripts/lib/ts-guard-utils.mts",
  ]) {
    fs.copyFileSync(path.resolve(file), path.join(root, file));
  }
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  const compilerOptions = {
    module: "ESNext",
    moduleResolution: "Bundler",
    types: [],
    noLib: true,
    paths: { "@fixture/*": ["./src/*"] },
    ...config,
  };
  for (const [file, text] of Object.entries({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions }),
    ...files,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

async function runChecker(root: string, signal: AbortSignal, script = "check-madge-import-cycles") {
  const result = await runNodeScript(
    ["--import", "./scripts/tsx.mjs", `scripts/${script}.ts`],
    process.env,
    undefined,
    { cwd: root, signal, requireProcessTreeExit: process.platform !== "win32" },
  );
  expect(result.error).toBeUndefined();
  return result;
}

it.for<[string, Record<string, string>, string[], object?, boolean?]>([
  [
    "clean graph with dynamic imports",
    {
      "src/a.ts": 'export const value = 1; void import("./b.js");',
      "src/b.ts": 'import { value } from "./a.js"; export const copy = value;',
      "src/dist/ignored.ts": 'import "./ignored.js";',
      "ui/view.tsx": 'import "../src/a.js"; export const view = <div />;',
    },
    [],
    { jsx: "preserve" },
  ],
  [
    "TSX component cycle",
    {
      "src/a.tsx": 'import "./b.js"; export const view = <div />;',
      "src/b.tsx": 'import "./a.js"; export const view = <span />;',
    },
    ["src/a.tsx", "src/b.tsx"],
    { jsx: "preserve" },
    true,
  ],
  [
    "alias, re-export and type-only cycle",
    {
      "src/a.ts": 'export { value } from "@fixture/b"; export type Value = number;',
      "src/b.ts": 'import type { Value } from "./a.js"; export const value: Value = 1;',
    },
    ["src/a.ts", "src/b.ts"],
  ],
  [
    "package export cycle",
    {
      "package.json": JSON.stringify({
        type: "module",
        name: "fixture-package",
        exports: { "./b": "./src/b.ts" },
      }),
      "src/a.ts": 'export { value } from "fixture-package/b";',
      "src/b.ts": 'import "./a.js"; export const value = 1;',
    },
    ["src/a.ts", "src/b.ts"],
  ],
  [
    "ambient declarations do not hide a physical source cycle",
    {
      "src/a.ts": 'export { value } from "@fixture/b";',
      "src/b.ts": 'import "./a.js"; export const value = 1;',
      "src/ambient.d.ts": 'declare module "@fixture/b" { export const value: number; }',
    },
    ["src/a.ts", "src/b.ts"],
  ],
  [
    "type-only cycle across a large source inventory",
    {
      "src/a.ts": 'export type { Value } from "@fixture/z"; export type Alias = string;',
      ...Object.fromEntries(
        Array.from({ length: 255 }, (_, i) => [
          `src/filler-${String(i).padStart(3, "0")}.ts`,
          "export {};",
        ]),
      ),
      "src/z.ts": 'import type { Alias } from "./a.js"; export type Value = Alias;',
    },
    ["src/a.ts", "src/z.ts"],
  ],
])("%s", async ([, files, cycle, config, runtime], { signal }) => {
  await fixtures.run(async () => {
    const root = createCheckerFixture(files, config);
    const result = await runChecker(root, signal);
    const count = cycle.length ? 1 : 0;
    expect(result).toMatchObject({
      status: count,
      stdout: `Madge import cycle check: ${count} cycle(s).\n`,
    });
    if (cycle.length) {
      expect(result.stderr).toContain(`# cycle 1\n  ${cycle.join("\n  -> ")}\n`);
    }
    if (runtime) {
      expect(await runChecker(root, signal, "check-import-cycles")).toMatchObject({
        status: 1,
        stdout: "Import cycle check: 1 runtime value cycle(s).\n",
      });
    }
  });
});

it("rejects invalid project configuration", async ({ signal }) => {
  await fixtures.run(async () => {
    const root = createCheckerFixture(
      { "src/a.ts": "export const value = 1;" },
      { unknownCompilerOption: true },
    );
    const result = await runChecker(root, signal);
    expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining("error TS5023") });
  });
});
