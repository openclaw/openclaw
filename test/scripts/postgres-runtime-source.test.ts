import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatePostgresRuntimeFiles } from "../../scripts/lib/postgres-runtime-source.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("PostgreSQL runtime constants", () => {
  it.each(["statePostgresRuntime", "agentPostgresRuntime", "agentSearchPostgresRuntime"])(
    "preserves %s lazy values, descriptors and receiver identity",
    (exportName) => {
      const fixture = {
        eagerSql: "CREATE TABLE sample (value text DEFAULT 'literal');\n",
        fragments: [{ id: "sample", tables: ["sample"], dependencies: [] }],
        expectedCatalog: [{ table: "sample", kind: "column", value: { nullable: false } }],
      };
      const root = createTempDir("postgres-runtime-source-");
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      const files = generatePostgresRuntimeFiles("runtime.ts", exportName, fixture);
      for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(root, name), source);
      }
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import assert from 'node:assert/strict';
import fs from 'node:fs';
const fixture = ${JSON.stringify(fixture)};
const { ${exportName}: runtime } = await import('./runtime.ts');
assert.deepEqual(Object.keys(runtime), Object.keys(fixture));
for (const key of Object.keys(fixture)) {
  const descriptor = Object.getOwnPropertyDescriptor(runtime, key);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, true);
}
const getter = Object.getOwnPropertyDescriptor(runtime, 'expectedCatalog').get;
const first = Object.create(runtime);
const second = Object.create(runtime);
const firstValue = getter.call(first);
firstValue[0].value.nullable = true;
assert.deepEqual(getter.call(second), fixture.expectedCatalog);
assert.equal(first.expectedCatalog, firstValue);
assert.equal(Object.getOwnPropertyDescriptor(runtime, 'expectedCatalog').get, getter);
const payload = './postgres-runtime-eagerSql.ts';
fs.renameSync(payload, payload + '.held');
assert.throws(() => runtime.eagerSql);
assert.equal(typeof Object.getOwnPropertyDescriptor(runtime, 'eagerSql').get, 'function');
fs.renameSync(payload + '.held', payload);
assert.equal(runtime.eagerSql, fixture.eagerSql);
assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, 'eagerSql'), {
  value: fixture.eagerSql, writable: true, enumerable: true, configurable: true,
});
const catalog = runtime.expectedCatalog;
assert.equal(runtime.expectedCatalog, catalog);
assert.deepEqual(structuredClone(runtime), fixture);
assert.equal(JSON.stringify(runtime), JSON.stringify(fixture));
console.log('values, lazy failure, descriptors and independent receivers passed');
`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.trim()).toBe(
        "values, lazy failure, descriptors and independent receivers passed",
      );
    },
  );
});
