import { expect, it } from "vitest";
import { inspectDatabaseWorkerBoundaries } from "../../scripts/lib/database-worker-compat.mts";

const legacyFile = "src/plugin-sdk/sqlite-runtime-legacy.ts";
const secondFile = "src/sessions/session-upstream-links.ts";
const first = "sdkExecuteSqliteQueryTakeFirstSync";
const second = "deleteSessionUpstreamLink";
const legacy = `
/** @deprecated Use the worker API; removal follows a stable deprecation window. */
export function ${first}() { return 1; }
`;
const owner = `
import { ${first} } from '../plugin-sdk/sqlite-runtime-legacy.js';
/** @deprecated Use the worker API; removal follows a stable deprecation window. */
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

it("permits a deprecated API only from an exact reviewed one-shot entry", () => {
  const doctorFile = "src/flows/doctor-tool-schema-projection.ts";
  const doctor = `import { ${first} } from '../plugin-sdk/sqlite-runtime-legacy.js';
    export function collectAgentRuntimeToolSchemaFindings() { return ${first}(); }`;
  const inspectDoctor = (file: string, source: string) =>
    inspectDatabaseWorkerBoundaries(
      process.cwd(),
      new Map(Object.entries({ [legacyFile]: legacy, [file]: source })),
      (candidate) => candidate === doctorFile,
      (candidate, operation) =>
        candidate === doctorFile && operation === "collectAgentRuntimeToolSchemaFindings"
          ? "T3"
          : undefined,
    );
  expect(inspectDoctor(doctorFile, doctor).violations).toEqual([]);
  expect(
    inspectDoctor(
      doctorFile,
      `export async function collectAgentRuntimeToolSchemaFindings() {
        const { ${first} } = await import('../plugin-sdk/sqlite-runtime-legacy.js');
        return ${first}();
      }`,
    ).violations,
  ).toEqual([]);
  for (const [file, source] of [
    [doctorFile, doctor.replace("collectAgentRuntimeToolSchemaFindings", "unreviewed")],
    ["src/flows/unreviewed.ts", doctor],
    [doctorFile, doctor.replace(`return ${first}()`, `return () => ${first}()`)],
  ] as const) {
    expect(inspectDoctor(file, source).violations).toEqual([
      expect.stringContaining("bundled runtime reference"),
    ]);
  }
});

const mixedReceiverFile = "src/gateway/model-account-connect.ts";
const mixedReceiver = `
  import { readKernel } from '../session-kernel.js';
  export function createModelAccountConnectService() {
    const readLegacy = () => readKernel();
    return {
      /** @deprecated Await listLinksAsync. */
      listLinks() { return readLegacy(); },
      async listLinksAsync() { return executeSqliteQuerySync(query); },
    };
  }
`;

it.each([
  ["direct call", "service.listLinks();"],
  ["escaped member", "register(service.listLinks);"],
])("rejects a bundled %s to a reviewed deprecated member", (_label, use) => {
  const result = inspect({
    [kernelFile]: kernel,
    [mixedReceiverFile]: mixedReceiver,
    "src/consumer.ts": `import { createModelAccountConnectService } from './gateway/model-account-connect.js';
      const service = createModelAccountConnectService(); ${use}`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(mixedReceiverFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("requires the reviewed member itself to remain deprecated", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [mixedReceiverFile]: mixedReceiver.replace("@deprecated", "Legacy:"),
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.violations).toEqual([
    `${mixedReceiverFile}:createModelAccountConnectService.listLinks: reviewed compatibility operation must be @deprecated`,
  ]);
});

it("keeps a local legacy helper live when an async sibling calls it", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [mixedReceiverFile]: mixedReceiver.replace(
      "async listLinksAsync() { return executeSqliteQuerySync(query); }",
      "async listLinksAsync() { return readLegacy(); }",
    ),
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.get(mixedReceiverFile)?.has("createModelAccountConnectService")).toBe(
    false,
  );
});

it("isolates reviewed members when a legacy wrapper and live factory share their receiver", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [mixedReceiverFile]: mixedReceiver,
    [secondFile]: `
      import { createModelAccountConnectService } from '../gateway/model-account-connect.js';
      /** @deprecated Use the worker API. */
      export function ${second}() { return createModelAccountConnectService(); }
    `,
    "src/consumer.ts": `
      import { createModelAccountConnectService } from './gateway/model-account-connect.js';
      createModelAccountConnectService().listLinksAsync();
    `,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(mixedReceiverFile)).toEqual(
    new Set([
      "createModelAccountConnectService.listLinks",
      "createModelAccountConnectService.readLegacy",
    ]),
  );
});

const bindingServiceFile = "src/infra/outbound/session-binding-service.ts";
const bindingService = `
  import { readKernel } from '../../session-kernel.js';
  type LegacyService = { listBySession: () => number };
  type Service = LegacyService & { listBySessionAsync: () => Promise<number> };
  const DEFAULT_SESSION_BINDING_SERVICE: Service = {
    /** @deprecated Await listBySessionAsync. */
    listBySession: () => readKernel(),
    listBySessionAsync: async () => 1,
  };
  export function getService(): Service { return DEFAULT_SESSION_BINDING_SERVICE; }
`;

it("isolates a typed singleton's deprecated member while its async API stays live", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [bindingServiceFile]: bindingService,
    "src/consumer.ts": `
      import { getService } from './infra/outbound/session-binding-service.js';
      getService().listBySessionAsync();
    `,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(bindingServiceFile)).toEqual(
    new Set(["DEFAULT_SESSION_BINDING_SERVICE.listBySession"]),
  );
});

const pluginStateLegacyFile = "src/plugin-state/plugin-state-store.legacy.ts";
const legacyStoreMethods = ["lookupMany", "consume", "clear"];
const legacyStore = `
  import { readKernel } from '../session-kernel.js';
  export type Store<T> = {
    ${legacyStoreMethods.map((name) => `${name}?: (value: T) => number;`).join("\n")}
    lookup(): number;
    entries(): number;
  };
  export function createSyncKeyedStore<T>(): Required<Store<T>> {
    return {
      ${legacyStoreMethods
        .map(
          (name) =>
            `/** @deprecated Await the V2 store. */ ${name}(value) { return readKernel(); },`,
        )
        .join("\n")}
      lookup() { return 1; },
      entries() { return 1; },
    };
  }
  export declare const runtime: { openSyncKeyedStore<T>(): Store<T> };
`;

it.each([
  ["Required factory", "createSyncKeyedStore<number>()"],
  ["runtime contract", "runtime.openSyncKeyedStore<number>()"],
])("guards every legacy store member through the %s", (_label, factory) => {
  for (const escape of [false, true]) {
    const result = inspect({
      [kernelFile]: kernel,
      [pluginStateLegacyFile]: legacyStore,
      "src/consumer.ts": `
        import { createSyncKeyedStore, runtime } from './plugin-state/plugin-state-store.legacy.js';
        const store = ${factory};
        ${legacyStoreMethods.map((name) => (escape ? `retain(store.${name});` : `store.${name}(1);`)).join("\n")}
      `,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
    expect(result.violations).toHaveLength(legacyStoreMethods.length);
    for (const name of legacyStoreMethods) {
      expect(result.violations).toContainEqual(
        expect.stringContaining(`createSyncKeyedStore.${name}`),
      );
    }
  }
});

it("rejects shorthand method escapes from typed receivers and parameters", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [pluginStateLegacyFile]: legacyStore,
    "src/consumer.ts": `
      import { createSyncKeyedStore, type Store } from './plugin-state/plugin-state-store.legacy.js';
      const { consume } = createSyncKeyedStore<number>();
      consume(1);
      export function receive({ clear }: Store<number>) { retain(clear); }
    `,
  });
  expect(result.violations).toEqual([
    expect.stringContaining("createSyncKeyedStore.consume"),
    expect.stringContaining("createSyncKeyedStore.clear"),
  ]);
  expect(result.operations.has(kernelFile)).toBe(false);
});

it("keeps scalar authority and unguarded projection reads independent of guarded store members", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [pluginStateLegacyFile]: legacyStore,
    "src/consumer.ts": `
      import { createSyncKeyedStore } from './plugin-state/plugin-state-store.legacy.js';
      const store = createSyncKeyedStore<number>();
      const { lookup } = store;
      lookup();
      store.entries();
    `,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(pluginStateLegacyFile)).toEqual(
    new Set(legacyStoreMethods.map((name) => `createSyncKeyedStore.${name}`)),
  );
});

it("does not trust a same-named deprecated member on another factory", () => {
  const result = inspect({
    [kernelFile]: kernel,
    [mixedReceiverFile]: `${mixedReceiver}
      export function createOtherService() {
        return {
          /** @deprecated Await listLinksAsync. */
          listLinks() { return readKernel(); },
        };
      }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.get(mixedReceiverFile)?.has("createOtherService.listLinks")).toBe(false);
});

it("allows async-only members selected from a dynamic namespace import", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';
      export async function queryAsync() { return 1; }`,
    "src/consumer.ts": `const { queryAsync } = await import('./plugin-sdk/barrel.js'); await queryAsync();`,
  });
  expect(result.violations).toEqual([]);
});

it.each([".queryAsync", "['queryAsync']"])(
  "allows a statically selected async member from an inline dynamic import: %s",
  (selector) => {
    const result = inspect({
      "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';
        export async function queryAsync() { return 1; }`,
      "src/consumer.ts": `await (await import('./plugin-sdk/barrel.js'))${selector}();`,
    });
    expect(result.violations).toEqual([]);
  },
);

it.each([".oldQuery", "['oldQuery']", "[key]"])(
  "rejects a legacy or computed member from an inline dynamic import: %s",
  (selector) => {
    const result = inspect({
      "src/plugin-sdk/barrel.ts": `export { ${first} as oldQuery } from './sqlite-runtime-legacy.js';`,
      "src/consumer.ts": `const key = 'oldQuery'; (await import('./plugin-sdk/barrel.js'))${selector}();`,
    });
    expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
  },
);

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
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.operations.get(secondFile)).toEqual(new Set([second]));
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

it("records profile reads inside the exact synchronous alias resolver", () => {
  const profileFile = "src/state/user-profiles-internal.ts";
  const result = inspect(
    {
      [profileFile]: `function readResolvedUserProfile(id, read) { return read(id); }
export function selectResolvedUserProfile() {
  return readResolvedUserProfile('id', (id) => executeSqliteQueryTakeFirstSync(db, query));
}`,
    },
    `import { selectResolvedUserProfile } from '../state/user-profiles-internal.js';
/** @deprecated Use workers. */
export function ${first}() { return selectResolvedUserProfile(); }`,
  );
  expect(result.violations).toEqual([]);
  expect(result.callLocations.get(profileFile)).toEqual(new Set(["1:53", "3:10", "3:48"]));
});

it.each(["readPluginState", "writePluginState"])(
  "follows inline callbacks through %s but keeps escaped callbacks live",
  (scope) => {
    const pluginStateFile = "src/plugin-state/plugin-state-store.sqlite.ts";
    const inspectCallback = (callback: string) =>
      inspect(
        {
          [pluginStateFile]: `import { readKernel } from '../session-kernel.js';
function ${scope}(operation, message, callback) { return callback(); }
export function accessPluginState() {
  return ${scope}('lookup', 'failed', ${callback});
}`,
          [kernelFile]: kernel,
        },
        `import { accessPluginState } from '../plugin-state/plugin-state-store.sqlite.js';
/** @deprecated Use workers. */
export function ${first}() { return accessPluginState(); }`,
      );

    const inline = inspectCallback("() => readKernel()");
    expect(inline.violations).toEqual([]);
    expect(inline.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));

    const escaped = inspectCallback("() => () => readKernel()");
    expect(escaped.operations.has(kernelFile)).toBe(false);
  },
);

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

it.each([
  {
    entryFile: "src/state/user-profiles.ts",
    entry: "ensureProfileForTailscaleIdentity",
    workerFile: "src/state/user-profiles.worker.ts",
    kernelFile: "src/state/user-profile-mutation.ts",
    kernel: "runUserProfileWriteTransaction",
    source: `import { runUserProfileWriteTransaction } from './user-profile-mutation.js';
      export function ensureProfileForTailscaleIdentity() { return runUserProfileWriteTransaction(); }`,
    kernelSource: `export function runUserProfileWriteTransaction() { return executeSqliteQuerySync(query); }`,
  },
  {
    entryFile: "src/state/user-profile-github-identity.ts",
    entry: "readUserProfileGitHubCommand",
    workerFile: "src/state/user-profile-read.worker.ts",
    kernelFile: "src/state/user-profile-github-identity.ts",
    kernel: "selectStoredGitHubIdentities",
    source: `function selectStoredGitHubIdentities() { return executeSqliteQuerySync(query); }
      function resolveCachedGitHubIdentityInDatabase() { return selectStoredGitHubIdentities(); }
      export function readUserProfileGitHubCommand() { return resolveCachedGitHubIdentityInDatabase(); }`,
    kernelSource: undefined,
  },
])("proves the profile worker chain through $entry", (fixture) => {
  const sources = new Map([
    [fixture.entryFile, fixture.source],
    [
      fixture.workerFile,
      `import { ${fixture.entry} } from './${fixture.entryFile.split("/").at(-1)!.replace(".ts", ".js")}';
        export const handlers = { run: () => ${fixture.entry}() };`,
    ],
  ]);
  if (fixture.kernelSource) {
    sources.set(fixture.kernelFile, fixture.kernelSource);
  }
  const inspectProfileChain = () =>
    inspectDatabaseWorkerBoundaries(
      process.cwd(),
      sources,
      () => false,
      (file) => (file === fixture.workerFile ? "W" : undefined),
    );
  expect(
    inspectProfileChain().nonRuntimeOperations.get(fixture.kernelFile)?.get(fixture.kernel),
  ).toBe("W");

  sources.set(
    "src/gateway/handler.ts",
    `import { ${fixture.entry} } from '../state/${fixture.entryFile.split("/").at(-1)!.replace(".ts", ".js")}';
      export function handle() { return ${fixture.entry}(); }`,
  );
  expect(
    inspectProfileChain().nonRuntimeOperations.get(fixture.kernelFile)?.has(fixture.kernel),
  ).not.toBe(true);
});

it("uses reviewed worker ownership for its complete handler table", () => {
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
    expect(escaped.nonRuntimeOperations.has(maintenanceFile)).toBe(caller === file);
  }
});

const channelAuthorityFile = "src/gateway/channel-operator-authority.ts";
const profileEmailsFile = "src/state/user-profiles-internal.ts";

function inspectChannelAuthority(source: string, extra: Record<string, string> = {}) {
  return inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map(
      Object.entries({
        [profileEmailsFile]: `export function selectUserProfileEmails() { return executeSqliteQuerySync(query); }`,
        [channelAuthorityFile]: `import { selectUserProfileEmails } from '../state/user-profiles-internal.js';
          function resolveChannelOperatorIdentityFacts() {
            return { isCurrent: () => selectUserProfileEmails() };
          }
          ${source}`,
        ...extra,
      }),
    ),
    () => false,
    (file, operation) =>
      file === channelAuthorityFile &&
      [
        "resolveChannelOperatorAdminAuthority",
        "resolveUpdateChannelOperatorAdminIdentityAuthority",
      ].includes(operation)
        ? "T3"
        : undefined,
  );
}

it.each([
  ["resolveChannelOperatorAdminAuthority", "captureLinkedOperatorAdmin"],
  ["resolveUpdateChannelOperatorAdminIdentityAuthority", "captureLinkedOperatorAdminIdentity"],
])("proves the retained identity callback at %s", (caller, receiver) => {
  const source = `
    function ${receiver}(cfg, linked, isCurrent) { return { isCurrent }; }
    export function ${caller}() {
      const prepared = resolveChannelOperatorIdentityFacts();
      return ${receiver}(null, null, prepared.isCurrent);
    }
  `;
  const result = inspectChannelAuthority(source);
  expect(result.nonRuntimeOperations.get(profileEmailsFile)?.get("selectUserProfileEmails")).toBe(
    "T3",
  );
  const liveSibling = inspectChannelAuthority(`${source}
    export function handle() { return resolveChannelOperatorIdentityFacts().isCurrent; }
  `);
  expect(liveSibling.nonRuntimeOperations.has(profileEmailsFile)).toBe(false);
});

it.each([
  ["runtime caller", "handle", "captureLinkedOperatorAdmin(null, null, prepared.isCurrent)"],
  [
    "wrong argument",
    "resolveChannelOperatorAdminAuthority",
    "captureLinkedOperatorAdmin(null, prepared.isCurrent, null)",
  ],
  ["unknown consumer", "resolveChannelOperatorAdminAuthority", "save(prepared.isCurrent)"],
])("keeps an identity callback live after a %s", (_label, caller, call) => {
  const result = inspectChannelAuthority(`
    function captureLinkedOperatorAdmin(cfg, linked, isCurrent) { return { isCurrent }; }
    function save(value) { return value; }
    export function ${caller}() {
      const prepared = resolveChannelOperatorIdentityFacts();
      return ${call};
    }
  `);
  expect(result.nonRuntimeOperations.has(profileEmailsFile)).toBe(false);
});

it("rejects a same-named identity consumer from another module", () => {
  const result = inspectChannelAuthority(
    `import { captureLinkedOperatorAdmin } from './unreviewed.js';
    export function resolveChannelOperatorAdminAuthority() {
      const prepared = resolveChannelOperatorIdentityFacts();
      return captureLinkedOperatorAdmin(null, null, prepared.isCurrent);
    }`,
    {
      "src/gateway/unreviewed.ts": `export function captureLinkedOperatorAdmin(cfg, linked, isCurrent) { return isCurrent; }`,
    },
  );
  expect(result.nonRuntimeOperations.has(profileEmailsFile)).toBe(false);
});
