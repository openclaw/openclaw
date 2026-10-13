import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findSourceImportBackedges } from "./source-import-closure.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let fixtureRoot: string;
let fixturePath: string;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "source-import-closure-"));
  fixturePath = path.relative(repoRoot, fixtureRoot);
  const files = {
    "raw.ts": 'import html from "./page.html?raw"; export { html };',
    "missing.ts": 'import html from "./missing.html?raw"; export { html };',
    "raw-value.ts": 'import "./forbidden.ts?raw=1";',
    "raw-empty-value.ts": 'import "./forbidden.ts?raw=";',
    "backedge.ts": 'import "./page.html?raw"; import "./forbidden.js";',
    "page.html": '<script type="module">import "./forbidden.js";</script>',
    "forbidden.ts": "export const value = 1;",
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixtureRoot, name), contents);
  }
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

it("treats an existing Vite raw import as file contents", () => {
  expect(
    findSourceImportBackedges(`${fixturePath}/raw.ts`, [`${fixturePath}/forbidden.ts`]),
  ).toEqual([]);
});

it("rejects a missing Vite raw import", () => {
  expect(() => findSourceImportBackedges(`${fixturePath}/missing.ts`, [])).toThrow(
    /Unresolved source import: .*missing\.ts -> \.\/missing\.html/,
  );
});

it("still follows source backedges alongside Vite raw imports", () => {
  expect(
    findSourceImportBackedges(`${fixturePath}/backedge.ts`, [`${fixturePath}/forbidden.ts`]),
  ).toEqual([`${fixturePath}/backedge.ts -> ${fixturePath}/forbidden.ts`]);
});

it.each(["raw-value", "raw-empty-value"])(
  "follows executable imports whose raw parameter has a value (%s)",
  (name) => {
    expect(
      findSourceImportBackedges(`${fixturePath}/${name}.ts`, [`${fixturePath}/forbidden.ts`]),
    ).toEqual([`${fixturePath}/${name}.ts -> ${fixturePath}/forbidden.ts`]);
  },
);
