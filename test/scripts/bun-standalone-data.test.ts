import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  standaloneDataExpression,
  standaloneEmbeddedPathsExpression,
  standaloneLookupExpression,
} from "../../scripts/lib/bun-standalone-data.mjs";

it("decodes only requested routing rows and retains their identity", () => {
  const entries = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [`path/${index}.js`, { index }]),
  );
  const parse = vi.fn(JSON.parse);
  const lookup = runInNewContext(standaloneLookupExpression(entries), {
    JSON: { stringify: JSON.stringify, parse },
  });
  expect(parse).not.toHaveBeenCalled();
  expect(lookup("missing")).toBeUndefined();
  expect(parse).not.toHaveBeenCalled();
  const first = lookup("path/0.js");
  expect(first).toEqual({ index: 0 });
  expect(lookup("path/0.js")).toBe(first);
  expect(lookup("path/999.js")).toEqual({ index: 999 });
  expect(parse).toHaveBeenCalledTimes(2);
});

it("preserves escaped keys, falsy values and JSON omission without prototype lookups", () => {
  const entries = Object.assign(Object.create(null), {
    'path/"quoted"\\file\n\t.js': ["separator\u2028text"],
    "💙": { value: 42 },
    "\ud800": "lone surrogate",
    __proto__: null,
    constructor: false,
    zero: 0,
    empty: "",
    absent: undefined,
  });
  Object.defineProperty(entries, "__proto__", { value: null, enumerable: true });
  const lookup = runInNewContext(standaloneLookupExpression(entries));
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      expect(lookup(key)).toEqual(value);
    }
  }
  for (const key of ["absent", "toString", "zzz", "", undefined]) {
    expect(lookup(key)).toBeUndefined();
  }
  expect(runInNewContext(standaloneLookupExpression({}))("anything")).toBeUndefined();
});

it("admits every embedded alias and destination, including noncanonical targets", () => {
  const paths = {
    "dist/main.js": "/$bunfs/root/runtime/dist/main.js",
    "source/main.ts": "/$bunfs/root/runtime/dist/main.js",
    "dist/worker.mjs": "/$bunfs/root/runtime/dist/worker.js",
    "native.cjs": "/$bunfs/root/standalone-entries/native.mjs",
  };
  const lookup = runInNewContext(standaloneEmbeddedPathsExpression(paths));
  for (const [alias, target] of Object.entries(paths)) {
    expect(lookup(alias)).toBe(target);
    expect(lookup(target)).toBe(target);
  }
  expect(lookup("/$bunfs/root/runtime/not-in-image.js")).toBeUndefined();
});

it("preserves embedded lookup data and escaped source text", () => {
  const expression = standaloneDataExpression({
    'path/"quoted"\\file.js': { size: 42, aliases: ["line\nbreak", "separator\u2028text"] },
    empty: {},
  });
  const lookup = runInNewContext(expression);
  expect(lookup['path/"quoted"\\file.js']).toEqual({
    size: 42,
    aliases: ["line\nbreak", "separator\u2028text"],
  });
  expect(Object.keys(lookup.empty)).toEqual([]);
});
