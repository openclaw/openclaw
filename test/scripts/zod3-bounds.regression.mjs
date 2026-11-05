import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const coreEntry = createRequire(
  new URL("../../extensions/discord/package.json", import.meta.url),
).resolve("@discord/embedded-app-sdk/package.json");
const coreRequire = createRequire(coreEntry);
const zodEntry = coreRequire.resolve("zod");
const esm = await import(pathToFileURL(resolve(dirname(zodEntry), "index.js")).href);
const cjs = coreRequire("zod");

for (const [format, { z }] of [
  ["ESM", esm],
  ["CJS", cjs],
]) {
  for (const async of [false, true]) {
    const parse = (schema, input) =>
      async ? schema.safeParseAsync(input) : schema.safeParse(input);
    for (const kind of ["array max", "array exact", "set max", "set exact"]) {
      test(`${format} ${async ? "async" : "sync"} ${kind} rejects before element/outer work`, async () => {
        let elements = 0;
        let outer = 0;
        const element = z.string().refine(() => {
          elements++;
          return true;
        });
        const collection = kind.startsWith("array") ? z.array(element) : z.set(element);
        const bounded = kind.endsWith("max")
          ? collection.max(2, "bounded")
          : kind.startsWith("array")
            ? collection.length(2, "bounded")
            : collection.size(2, "bounded");
        const schema = z.object({
          values: bounded.refine(() => {
            outer++;
            return true;
          }),
        });
        const values = kind.startsWith("array") ? ["a", "b", "c"] : new Set(["a", "b", "c"]);
        const result = await parse(schema, { values });
        assert.equal(result.success, false);
        assert.deepEqual([elements, outer], [0, 0]);
        assert.equal(result.error.issues.length, 1);
        assert.equal(result.error.issues[0].code, "too_big");
        assert.deepEqual(result.error.issues[0].path, ["values"]);
        assert.equal(result.error.issues[0].message, "bounded");
      });
    }
    test(`${format} ${async ? "async" : "sync"} preserves valid transforms, lower bounds, unions and wrong types`, async () => {
      const arr = z.array(z.string().transform((s) => s.toUpperCase())).max(2);
      assert.deepEqual((await parse(arr, ["a", "b"])).data, ["A", "B"]);
      assert.equal(
        (await parse(z.array(z.string()).length(2), ["a"])).error.issues[0].code,
        "too_small",
      );
      assert.equal(
        (await parse(z.set(z.string()).min(2), new Set(["a"]))).error.issues[0].code,
        "too_small",
      );
      assert.equal((await parse(arr, {})).error.issues[0].code, "invalid_type");
      assert.equal(
        (await parse(z.set(z.string()).max(1), [])).error.issues[0].code,
        "invalid_type",
      );
      assert.equal(
        (await parse(z.union([z.array(z.string()).max(1), z.literal("fallback")]), ["a", "b"]))
          .error.issues[0].code,
        "invalid_union",
      );
      assert.equal(
        (await parse(z.union([arr, z.literal("fallback")]), "fallback")).data,
        "fallback",
      );
      assert.deepEqual(
        (
          await parse(
            z.preprocess((v) => v.slice(0, 2), arr),
            ["a", "b", "c"],
          )
        ).data,
        ["A", "B"],
      );
    });
  }
}
