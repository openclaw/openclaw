import { expect, it } from "vitest";
import { inspectDatabaseWorkerCompatibility } from "../../scripts/lib/database-worker-compat.mts";

const legacyFile = "src/plugin-sdk/sqlite-runtime-legacy.ts";
const secondFile = "src/sessions/session-upstream-links.ts";
const first = "executeSqliteQueryTakeFirstSyncLegacy";
const second = "deleteSessionUpstreamLink";
const legacy = `
/** @deprecated Use the worker API; removed in the next SDK major. */
export function ${first}() { return 1; }
`;
const owner = `
import { ${first} } from '../plugin-sdk/sqlite-runtime-legacy.js';
/** @deprecated Use the worker API; removed in the next SDK major. */
export function ${second}() { return ${first}(); }
`;

function inspect(extra: Record<string, string>, source = legacy) {
  return inspectDatabaseWorkerCompatibility(
    process.cwd(),
    new Map(Object.entries({ [legacyFile]: source, [secondFile]: owner, ...extra })),
  );
}

it("retains deprecated-only operations through pure reexports and type-only references", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';`,
    "src/types.ts": `
      import type { oldQuery } from './plugin-sdk/barrel.js';
      import { ${second} } from './sessions/session-upstream-links.js';
      export type Query = typeof oldQuery;
      export type OtherQuery = typeof ${second};
      export function unrelated(${first}: () => number) { return ${first}(); }
    `,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(legacyFile)).toEqual(new Set([first]));
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
});

it.each([
  ["aliased barrel call", `import { oldQuery as read } from './plugin-sdk/barrel.js'; read();`],
  ["namespace call", `import * as legacy from './plugin-sdk/barrel.js'; legacy.oldQuery();`],
  [
    "namespace element call",
    `import * as legacy from './plugin-sdk/barrel.js'; legacy['oldQuery']();`,
  ],
  [
    "dynamic namespace import",
    `const legacy = await import('./plugin-sdk/barrel.js'); legacy.oldQuery();`,
  ],
  [
    "dynamic namespace rest binding",
    `const { ...legacy } = await import('./plugin-sdk/barrel.js'); legacy.oldQuery();`,
  ],
  [
    "dynamic nested namespace binding",
    `const { nested: { oldQuery } } = await import('./plugin-sdk/barrel.js'); oldQuery();`,
  ],
  [
    "dynamic computed namespace binding",
    `const key = 'oldQuery'; const { [key]: read } = await import('./plugin-sdk/barrel.js'); read();`,
  ],
  [
    "escaped callback",
    `import { oldQuery } from './plugin-sdk/barrel.js'; export function callback() { return oldQuery; }`,
  ],
  [
    "shorthand callback escape",
    `import { oldQuery } from './plugin-sdk/barrel.js'; export const callbacks = { oldQuery };`,
  ],
  [
    "escaped namespace",
    `import * as legacy from './plugin-sdk/barrel.js'; export const api = legacy;`,
  ],
  [
    "unregistered deprecated wrapper",
    `import { oldQuery } from './plugin-sdk/barrel.js';
     /** @deprecated Use workers. */
     export function wrapper() { return oldQuery(); }`,
  ],
])("rejects a bundled %s without allowing it to hide the live operation", (_name, consumer) => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';`,
    "src/consumer.ts": consumer,
  });
  expect(result.violations).toEqual([
    expect.stringMatching(/src\/consumer.ts:\d+:\d+: bundled runtime reference/),
  ]);
  expect(result.operations.has(legacyFile)).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
});

it("checks same-file calls and propagates reachability through reviewed wrappers", () => {
  const result = inspect(
    {
      "extensions/plugin/runtime.ts": `import { ${second} } from '../../src/sessions/session-upstream-links.js'; ${second}();`,
    },
    `${legacy}\nimport { ${second} } from '../sessions/session-upstream-links.js';
    function bundled() { return ${second}(); }`,
  );
  expect(result.operations.size).toBe(0);
  expect(result.violations).toHaveLength(2);
});

it("requires the reviewed declaration's deprecation marker", () => {
  const result = inspect({}, legacy.replace("@deprecated", "Legacy:"));
  expect(result.operations.has(legacyFile)).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
  expect(result.violations).toEqual([
    `${legacyFile}:${first}: reviewed compatibility operation must be @deprecated`,
  ]);
});

it("does not classify deprecated methods or their unverified factory objects", () => {
  const result = inspect({
    "src/gateway/github-publication-coordinator-methods.ts": `
      import { ${first} } from '../plugin-sdk/sqlite-runtime-legacy.js';
      export function createGitHubPublicationCoordinatorMethods() {
        return {
          /** @deprecated Use the awaited replacement. */
          markReported() { return ${first}(); },
        };
      }
    `,
  });
  expect(result.operations.has(legacyFile)).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
  expect(result.operations.has("src/gateway/github-publication-coordinator-methods.ts")).toBe(
    false,
  );
  expect(result.violations).toEqual([
    expect.stringContaining("src/gateway/github-publication-coordinator-methods.ts:"),
  ]);
});

it("allows async-only members selected from a dynamic namespace import", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';
      export async function queryAsync() { return 1; }`,
    "src/consumer.ts": `const { queryAsync } = await import('./plugin-sdk/barrel.js'); await queryAsync();`,
  });
  expect(result.violations).toEqual([]);
});

it("follows renamed namespace reexports and default exports", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export * as old from './sqlite-runtime-legacy.js';
      export { ${second} as default } from '../sessions/session-upstream-links.js';`,
    "src/consumer.ts": `
      import query, { old as api } from './plugin-sdk/barrel.js';
      api.${first}();
      query();
    `,
  });
  expect(result.operations.size).toBe(0);
  expect(result.violations).toHaveLength(2);
});

it.each(["openclaw/plugin-sdk", "@openclaw/plugin-sdk"])(
  "resolves the root SDK alias %s",
  (specifier) => {
    const result = inspect({
      "src/plugin-sdk/index.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';`,
      "src/consumer.ts": `import { oldQuery } from '${specifier}'; oldQuery();`,
    });
    expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
  },
);

it("retires deleted operations even when their module keeps other exports", () => {
  const result = inspect(
    { [secondFile]: "export {};" },
    `export function ${first}Async() { return 1; }`,
  );
  expect(result.operations.size).toBe(0);
  expect(result.violations).toEqual([]);
});

it("does not read missing compatibility files from the current checkout", () => {
  expect(inspectDatabaseWorkerCompatibility(process.cwd(), new Map())).toEqual({
    operations: new Map(),
    violations: [],
  });
});
