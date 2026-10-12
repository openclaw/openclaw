import { expect, it } from "vitest";
import { inspectDatabaseWorkerBoundaries } from "../../scripts/lib/database-worker-compat.mts";

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
  return inspectDatabaseWorkerBoundaries(
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
  expect(result.violations).toEqual([
    expect.stringContaining("extensions/plugin/runtime.ts:"),
    expect.stringContaining(`${legacyFile}:`),
    expect.stringContaining(
      `${legacyFile}:${first}: reviewed compatibility operation is reachable`,
    ),
  ]);
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
  expect(inspectDatabaseWorkerBoundaries(process.cwd(), new Map())).toEqual({
    operations: new Map(),
    callLocations: new Map(),
    nonRuntimeOperations: new Map(),
    nonRuntimeCallLocations: new Map(),
    violations: [],
  });
});

const kernelFile = "src/session-kernel.ts";
const kernel = `export function readKernel() { return 1; }`;
const sharedOwner = `
  import { readKernel } from '../session-kernel.js';
  /** @deprecated Use workers. */
  export function ${second}() { return readKernel(); }
`;
const receiverOwner = `
  import { readKernel } from '../session-kernel.js';
  /** @deprecated Use workers. */
  export function ${second}() { return { read() { return readKernel(); } }; }
`;

it("proves a transitive mixed kernel with only worker and deprecated callers", () => {
  const result = inspect({
    [secondFile]: sharedOwner,
    [kernelFile]: `import { leaf } from './leaf.js';
      export function readKernel() { return leaf(); }`,
    "src/leaf.ts": `export function leaf() { return 1; }`,
    "src/reader.worker.ts": `import { readKernel as read } from './session-kernel.js'; read();`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get("src/leaf.ts")).toEqual(new Set(["leaf"]));
});

it.each([
  ["live call", "export function read() { return readKernel(); }"],
  ["escaped callback", "export const callback = readKernel;"],
  ["namespace escape", "export const callback = kernelApi;"],
])("keeps a mixed kernel live after a bundled %s", (_label, consumer) => {
  const result = inspect({
    [secondFile]: sharedOwner,
    [kernelFile]: `import { leaf } from './leaf.js';
      export function readKernel() { return leaf(); }`,
    "src/leaf.ts": `export function leaf() { return 1; }`,
    "src/consumer.ts": `import { readKernel } from './session-kernel.js';
      import * as kernelApi from './session-kernel.js'; ${consumer}`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/leaf.ts")).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
});

it.each(["register(readKernel)", "register(() => readKernel())"])(
  "keeps an escaped worker callback live: %s",
  (registration) => {
    const result = inspect({
      [secondFile]: sharedOwner,
      [kernelFile]: kernel,
      "src/reader.worker.ts": `import { readKernel } from './session-kernel.js';
      ${registration};`,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
  },
);

it.each([
  ["object method", "{ read() { return readKernel(); } }"],
  ["arrow property", "{ read: () => readKernel() }"],
  ["function property", "{ read: function () { return readKernel(); } }"],
  ["returned arrow", "() => readKernel()"],
  ["returned function", "function () { return readKernel(); }"],
])("proves kernels reached only through a deprecated factory's %s", (_label, value) => {
  const result = inspect({
    [secondFile]: `
      import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export function ${second}() { return ${value}; }`,
    [kernelFile]: kernel,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(secondFile)?.has(second)).toBe(true);
});

it.each([
  [
    "direct factory call",
    `import { ${second} } from './sessions/session-upstream-links.js'; ${second}().read();`,
  ],
  [
    "aliased factory call",
    `import { ${second} as create } from './sessions/session-upstream-links.js'; create().read();`,
  ],
  [
    "reexported factory call",
    `import { create } from './plugin-sdk/receivers.js'; create().read();`,
  ],
  [
    "SDK subpath factory call",
    `import { create } from 'openclaw/plugin-sdk/receivers'; create().read();`,
  ],
  [
    "scoped SDK subpath factory call",
    `import { create } from '@openclaw/plugin-sdk/receivers'; create().read();`,
  ],
  [
    "dynamic factory call",
    `const { create } = await import('./plugin-sdk/receivers.js'); create().read();`,
  ],
  [
    "returned object escape",
    `import { ${second} } from './sessions/session-upstream-links.js'; register(${second}());`,
  ],
])("keeps a receiver family live after a bundled %s", (_label, consumer) => {
  const result = inspect({
    [secondFile]: receiverOwner,
    [kernelFile]: kernel,
    "src/plugin-sdk/receivers.ts": `export { ${second} as create } from '../sessions/session-upstream-links.js';`,
    "src/consumer.ts": consumer,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps a returned callback live when bundled code registers it", () => {
  const result = inspect({
    [secondFile]: `import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export function ${second}() { return () => readKernel(); }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${second} } from './sessions/session-upstream-links.js';
      register(${second}());`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps shared receiver methods live when an async factory also creates them", () => {
  const result = inspect({
    [secondFile]: `import { createReceiver } from '../receiver.js';
      /** @deprecated Use workers. */
      export function ${second}() { return createReceiver(); }`,
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      export function createReceiver() { return { read() { return readKernel(); } }; }
      export async function createReceiverAsync() { return createReceiver(); }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
  expect(result.violations).toEqual([]);
});

it.each(["() => readKernel()", "function () { return readKernel(); }"])(
  "keeps a function-valued receiver property live when it escapes: %s",
  (value) => {
    const result = inspect({
      [secondFile]: `import { readKernel } from '../session-kernel.js';
        /** @deprecated Use workers. */
        export function ${second}() {
          return { read: ${value}, start() { register(this.read); } };
        }`,
      [kernelFile]: kernel,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
    expect(result.operations.has(secondFile)).toBe(false);
    expect(result.violations).toEqual([]);
  },
);

it("keeps unregistered nondeprecated receiver factories live", () => {
  const result = inspect({
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      export function createReceiver() { return { read() { return readKernel(); } }; }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.violations).toEqual([]);
});

it("retains a receiver escaped by a deprecated wrapper without inventing a factory caller", () => {
  const result = inspect({
    [secondFile]: receiverOwner,
    [kernelFile]: kernel,
    [legacyFile]: `import { ${second} } from '../sessions/session-upstream-links.js';
      /** @deprecated Use workers. */
      export function ${first}() {
        const receiver = ${second}();
        register(receiver.read);
      }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([]);
});

it("proves kernels reached only through a deprecated class receiver", () => {
  const result = inspect({
    [secondFile]: `import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export class ${second} {
        constructor() { readKernel(); }
        read() { return readKernel(); }
      }`,
    [kernelFile]: kernel,
  });
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(secondFile)?.has(second)).toBe(true);
  expect(result.violations).toEqual([]);
});

it("rejects bundled construction of a deprecated class receiver", () => {
  const result = inspect({
    [secondFile]: `import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export class ${second} { read() { return readKernel(); } }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${second} as Receiver } from './sessions/session-upstream-links.js';
      new Receiver().read();`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps a deprecated receiver live when a bundled class extends it", () => {
  const result = inspect({
    [secondFile]: `import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export class ${second} { read() { return readKernel(); } }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${second} as Receiver } from './sessions/session-upstream-links.js';
      export class ActiveReceiver extends Receiver {}`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it.each([
  ["inheritance", "extends Base", "read() { return readKernel(); }"],
  ["field initializer", "", "read = () => readKernel();"],
  ["computed member name", "", "[readKernel()]() { return readKernel(); }"],
  ["static block", "", "static { readKernel(); } read() { return readKernel(); }"],
  ["decorated member", "", "@decorate read() { return readKernel(); }"],
  [
    "decorated parameter",
    "",
    "constructor(@decorate value: unknown) {} read() { return readKernel(); }",
  ],
])("keeps deprecated classes with %s live", (_label, heritage, member) => {
  const result = inspect({
    [secondFile]: `import { readKernel } from '../session-kernel.js';
      class Base {}
      /** @deprecated Use workers. */
      export class ${second} ${heritage} { ${member} }`,
    [kernelFile]: kernel,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(secondFile)).toBe(false);
  expect(result.violations).toEqual([]);
});

it("rejects a deprecated factory reached through a live receiver method", () => {
  const result = inspect({
    [secondFile]: `import { createReceiver } from '../receiver.js';
      /** @deprecated Use workers. */
      export function ${second}() { return createReceiver(); }`,
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      import { ${first} } from './plugin-sdk/sqlite-runtime-legacy.js';
      export function createReceiver() {
        return { read() { ${first}(); return readKernel(); } };
      }
      export async function createReceiverAsync() { return createReceiver(); }`,
  });
  expect(result.operations.has(legacyFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining(`${legacyFile}:${first}:`)]);
});

it("records SQL inside a closed receiver method as compatibility-only", () => {
  const result = inspect({
    [secondFile]: `/** @deprecated Use workers. */
export function ${second}() {
  return { read() { return executeSqliteQuerySync(query); } };
}`,
  });
  expect(result.operations.get(secondFile)?.has(`${second}.read`)).toBe(true);
  expect(result.callLocations.get(secondFile)).toEqual(new Set(["3:28"]));
  expect(result.violations).toEqual([]);
});

it.each(["register(() => readKernel())", "return register(() => readKernel())"])(
  "does not inherit a compatibility scope through callback arguments: %s",
  (registration) => {
    const result = inspect({
      [secondFile]: `import { readKernel } from '../session-kernel.js';
      /** @deprecated Use workers. */
      export function ${second}() { ${registration}; }`,
      [kernelFile]: kernel,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
  },
);

it("rejects a reviewed API escaped by a discovered helper", () => {
  const result = inspect({
    [secondFile]: `import { helper } from '../helper.js';
      /** @deprecated Use workers. */
      export function ${second}() { helper(); }`,
    "src/helper.ts": `import { ${first} } from './plugin-sdk/sqlite-runtime-legacy.js';
      export function helper() { register(${first}); }`,
  });
  expect(result.operations.has(legacyFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/helper.ts:")]);
});

it("records direct call locations but excludes nested callback SQL", () => {
  const result = inspect(
    {},
    `/** @deprecated Use workers. */
export function ${first}() {
  executeSqliteQuerySync(query);
  register(() => executeSqliteQuerySync(query));
}`,
  );
  expect(result.callLocations.get(legacyFile)).toEqual(new Set(["3:3", "4:3"]));
});

it("does not confuse a nested function path with a live top-level namesake", () => {
  const result = inspect({
    [secondFile]: `import { wrapper } from '../wrapper.js';
      /** @deprecated Use workers. */
      export function ${second}() { wrapper(); }`,
    "src/wrapper.ts": `export function wrapper() {
      const local = () => { function same() { return 1; } return 1; };
      return local;
    }
    export function same() { return 2; }`,
  });
  expect(result.operations.get("src/wrapper.ts")?.has("same")).toBe(false);
});

const maintenanceFile = "src/state/openclaw-state-db-maintenance.ts";
const maintenanceSource = `
export function writeCurrentStateSchemaMetadata() { return persistSchema(); }
function persistSchema() { return executeSqliteQuerySync(query); }
export function runStateSchemaMigrationTransaction(db, path, operation) { return operation(); }
`;
const doctorSource = `
  import { writeCurrentStateSchemaMetadata, runStateSchemaMigrationTransaction } from '../state/openclaw-state-db-maintenance.js';
  export function doctor() {
    return runStateSchemaMigrationTransaction(db, path, () => writeCurrentStateSchemaMetadata());
  }
`;

function inspectMaintenance(extra: Record<string, string> = {}) {
  return inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map(
      Object.entries({
        [maintenanceFile]: maintenanceSource,
        "src/commands/doctor.ts": doctorSource,
        ...extra,
      }),
    ),
    (file) =>
      file.startsWith("src/commands/") || file.includes("migration") || file.endsWith(".worker.ts"),
    (file) =>
      file === "src/commands/doctor.ts"
        ? "T3"
        : file === "src/read.worker.ts" || file === "src/state/user-github-connections.worker.ts"
          ? "W"
          : undefined,
  );
}

it("proves maintenance-only kernels through the exact synchronous migration scope", () => {
  const result = inspectMaintenance({
    "src/read.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      writeCurrentStateSchemaMetadata();`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.size).toBe(0);
  expect(result.nonRuntimeOperations.get(maintenanceFile)).toEqual(
    new Map([
      ["writeCurrentStateSchemaMetadata", "T3"],
      ["persistSchema", "T3"],
    ]),
  );
  expect(result.nonRuntimeCallLocations.get(maintenanceFile)).toEqual(new Set(["2:60", "3:35"]));
});

it.each([
  [
    "Gateway caller",
    "src/gateway/consumer.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function handle() { return write(); }`,
  ],
  [
    "escaped Doctor callback",
    "src/commands/doctor.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function doctor() { return () => write(); }`,
  ],
  [
    "migration filename lead",
    "src/infra/state-migrations.unreviewed.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function migrate() { return write(); }`,
  ],
  [
    "SDK reexport",
    "src/plugin-sdk/schema.ts",
    `export { writeCurrentStateSchemaMetadata } from '../state/openclaw-state-db-maintenance.js';`,
  ],
])("keeps maintenance candidates live after a %s", (_label, file, source) => {
  const result = inspectMaintenance({ [file]: source });
  expect(result.violations).toEqual([]);
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("does not trust a same-named callback scope from another module", () => {
  const result = inspectMaintenance({
    "src/commands/doctor.ts":
      doctorSource.replace(
        "writeCurrentStateSchemaMetadata, runStateSchemaMigrationTransaction",
        "writeCurrentStateSchemaMetadata",
      ) + `import { runStateSchemaMigrationTransaction } from '../impostor.js';`,
    "src/impostor.ts": `export function runStateSchemaMigrationTransaction(db, path, operation) { return operation; }`,
  });
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("keeps a kernel live through an unreviewed worker-named wrapper called by the Gateway", () => {
  const result = inspectMaintenance({
    "src/unregistered.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      export function writeSchema() { return writeCurrentStateSchemaMetadata(); }`,
    "src/gateway/consumer.ts": `import { writeSchema } from '../unregistered.worker.js';
      export function handle() { return writeSchema(); }`,
  });
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("classifies a shared kernel with exclusively worker callers as worker-owned", () => {
  const result = inspectMaintenance({
    "src/commands/doctor.ts": "export {};",
    "src/read.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      writeCurrentStateSchemaMetadata();`,
  });
  expect(result.nonRuntimeOperations.get(maintenanceFile)).toEqual(
    new Map([
      ["writeCurrentStateSchemaMetadata", "W"],
      ["persistSchema", "W"],
    ]),
  );
});

it("requires the registered worker module, table, and operation for a handler callback", () => {
  const file = "src/state/user-github-connections.worker.ts";
  const handler = `import { writeCurrentStateSchemaMetadata } from './openclaw-state-db-maintenance.js';
    export const userGitHubConnectionOperations = {
      "userGitHubConnections.list": () => writeCurrentStateSchemaMetadata(),
    } satisfies Handlers;`;
  const result = inspectMaintenance({ "src/commands/doctor.ts": "export {};", [file]: handler });
  expect(
    result.nonRuntimeOperations.get(maintenanceFile)?.get("writeCurrentStateSchemaMetadata"),
  ).toBe("W");
  for (const [caller, source] of [
    [file, handler.replace("userGitHubConnections.list", "unregistered")],
    [file, handler.replace("userGitHubConnectionOperations", "unregistered")],
    ["src/state/unregistered.worker.ts", handler],
  ] as const) {
    const escaped = inspectMaintenance({
      "src/commands/doctor.ts": "export {};",
      [caller]: source,
    });
    expect(escaped.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
  }
});
