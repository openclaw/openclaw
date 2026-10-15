import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gitRuntimeStagingPath } from "../infra/update-runtime-staging.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { inspectPluginSourceDependencies } from "./plugin-generation-source-inspection.js";

// Artifact tests evaluate captured bytes independently; managed Node execution has binder suites.
function createArtifactLoader(artifact: ReturnType<typeof capturePluginGenerationArtifact>) {
  return createJiti(artifact.rootDir, { fsCache: false, moduleCache: false, tryNative: false });
}

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it("keeps the plugin source identity independent of Git rollback retirement", () => {
  const source = temp.make("plugin-update-digest-");
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 1;");
  const staging = gitRuntimeStagingPath(path.join(source, "node_modules"));
  fs.mkdirSync(path.join(staging, "previous"), { recursive: true });
  fs.writeFileSync(path.join(staging, "previous", "old.cjs"), "exports.value = 0;");
  const artifact = capturePluginGenerationArtifact(source);
  cleanups.push(artifact.dispose);
  fs.rmSync(staging, { recursive: true });
  const after = capturePluginGenerationArtifact(source);
  cleanups.push(after.dispose);
  expect(after.sourceDigest).toBe(artifact.sourceDigest);
});

it.each([
  ...["await using"].map((declaration) => ({
    name: `${declaration} declarations`,
    sourceText: `${declaration} resource = null;
      const first = import('./a.js');
      export function later() { return import('./b.js'); }`,
    references: ["./b.js", "./a.js"],
  })),
  {
    name: "exported loop assignments",
    sourceText: `export let value;
      for ([value = import('./a.js')] of [[import('./b.js')]]) {}`,
    references: ["./b.js", "./a.js"],
  },
  {
    name: "imported loop assignments",
    sourceText: `import { value } from './value.js';
      for ([value = import('./a.js')] of [[import('./b.js')]]) {}`,
    references: ["./value.js", "./b.js"],
  },
  {
    name: "reserved export declarations",
    sourceText: "export const { flag: __esModule } = {}; import('./a.js');",
    references: [],
  },
])("preserves transformed references when inspecting $name", ({ sourceText, references }) => {
  const source = temp.make("plugin-reference-inspection-");
  const entry = path.join(source, "entry.mjs");
  fs.writeFileSync(entry, sourceText);
  for (const name of ["a.js", "b.js", "value.js"]) {
    fs.writeFileSync(path.join(source, name), "export const value = 'fixture';");
  }
  const inspection = inspectPluginSourceDependencies([{ rootDir: source, entryFile: entry }]);
  expect(inspection.references).toEqual(
    references.map((specifier) => ({
      source: entry,
      specifier,
      target: path.join(source, specifier),
    })),
  );
});

it("keeps authored absolute references on the native source graph", async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-absolute-inputs-"));
  cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
  const dependency = path.join(source, "node_modules", "owned-dependency");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "absolute-inputs",
      type: "module",
      dependencies: { "owned-dependency": "1.0.0" },
    }),
  );
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    '{"name":"owned-dependency","main":"index.cjs"}',
  );
  const commonJs = path.join(source, "value.cjs");
  const esm = path.join(source, "value.mjs");
  const urlOnly = path.join(source, "url.mjs");
  const dependencyEntry = path.join(dependency, "index.cjs");
  const anchor = path.join(source, "anchor.cjs");
  const entry = path.join(source, "entry.mjs");
  const fileUrl = pathToFileURL(urlOnly).href;
  const anchorUrl = pathToFileURL(anchor).href;
  const absoluteEsm = process.platform === "win32" ? pathToFileURL(esm).href : esm;
  fs.writeFileSync(anchor, "module.exports = {};");
  // The anchor/dependency are separate inputs; local module ownership comes from literal imports.
  fs.writeFileSync(
    path.join(source, "common.cjs"),
    `
      exports.dependency = require('owned-dependency');
      exports.read = () => [require(${JSON.stringify(commonJs)}).value,
        require(${JSON.stringify(dependencyEntry)}).value];
    `,
  );
  fs.writeFileSync(
    entry,
    `
      import { createRequire } from 'node:module';
      import './anchor.cjs'; import common from './common.cjs';
      import { value as absolute } from ${JSON.stringify(absoluteEsm)};
      import { value as fileUrl } from ${JSON.stringify(fileUrl)};
      const fromPath = createRequire(${JSON.stringify(anchor)});
      const fromUrl = createRequire(${JSON.stringify(anchorUrl)});
      const fromObject = createRequire(new URL(${JSON.stringify(anchorUrl)}));
      export const read = async () => [absolute, fileUrl,
        (await import(${JSON.stringify(fileUrl)})).value, ...common.read(),
        fromPath('./value.cjs').value, fromUrl('./value.cjs').value,
        fromObject('./value.cjs') === fromPath('./value.cjs')];
    `,
  );
  const write = (value: string) => {
    fs.writeFileSync(commonJs, `exports.value = ${JSON.stringify(value)};`);
    fs.writeFileSync(esm, `export const value = ${JSON.stringify(value)};`);
    fs.writeFileSync(urlOnly, `export const value = ${JSON.stringify(value)};`);
    fs.writeFileSync(dependencyEntry, `exports.value = ${JSON.stringify(value)};`);
  };
  const capture = () => {
    const artifact = capturePluginGenerationArtifact(source, entry);
    cleanups.push(artifact.dispose);
    const host = createArtifactLoader(artifact);
    expect(artifact.hasSource(dependencyEntry)).toBe(false);
    for (const owned of [commonJs, esm, urlOnly]) {
      expect(artifact.hasSource(owned)).toBe(true);
    }
    return () => host(artifact.resolve(entry)) as { read(): Promise<unknown[]> };
  };
  write("before");
  const first = capture();
  write("after");
  const second = capture();
  await expect(first().read()).resolves.toEqual([
    "after",
    "after",
    "after",
    "after",
    "after",
    "after",
    "after",
    true,
  ]);
  await expect(second().read()).resolves.toEqual([
    "after",
    "after",
    "after",
    "after",
    "after",
    "after",
    "after",
    true,
  ]);
});

it.each([
  ["named", "import { createRequire as factory } from 'node:module';", "factory", "require"],
  ["alias", "import { createRequire as factory } from 'module';", "factory", "local"],
  ["default", "import nativeModule from 'node:module';", "nativeModule.createRequire", "local"],
  [
    "inline-resolve",
    "import { createRequire as factory } from 'node:module';",
    "factory",
    "inline-resolve",
  ],
  [
    "typescript-literal",
    "import { createRequire as factory } from 'node:module';",
    "factory",
    "require",
    "'owner-dependency/package.json' as const",
    "ts",
  ],
])(
  "freezes native %s createRequire package edges without capturing labels",
  (
    _name,
    imports,
    factory,
    binding,
    literal = "'owner-dependency/package.json'",
    extension = "mjs",
  ) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-native-require-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ dependencies: { "already-bundled-missing-package": "1.0.0" } }),
    );
    for (const name of ["owner-dependency", "label-dependency"]) {
      const dependency = path.join(source, "node_modules", name);
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"index.cjs"}');
      fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 'before';");
    }
    const entry = path.join(source, `entry.${extension}`);
    const currentRequire = `${factory}(import.meta.url)`;
    const load =
      binding === "inline-resolve"
        ? `${currentRequire}(path.join(path.dirname(${currentRequire}.resolve(${literal})), 'index.cjs'))`
        : binding === "require"
          ? `${binding}(path.join(path.dirname(${binding}.resolve(${literal})), 'index.cjs'))`
          : `${binding}('owner-dependency')`;
    fs.writeFileSync(path.join(source, "private.txt"), "unrelated");
    fs.writeFileSync(path.join(source, "other.cjs"), "");
    fs.writeFileSync(path.join(source, "relative.cjs"), 'exports.value = "relative-before";');
    fs.writeFileSync(
      entry,
      `${imports}
    import path from 'node:path';
    ${binding.startsWith("inline") ? "" : `const ${binding} = ${currentRequire};`}
    const labels = { resolve: value => value };
    export const label = labels.resolve('./private.txt');
    function shadow(local) { return local.resolve('label-dependency'); }
    export const shadowLabel = shadow(labels);
    function shadowFactory(factory) {
      const local = factory(import.meta.url);
      return local.resolve('label-dependency');
    }
    export const factoryLabel = shadowFactory(() => labels);
    const other = ${factory}(new URL('./other.cjs', import.meta.url));
    export const ignoredAnchor = () => other.resolve('label-dependency');
    export const read = () => ${load}.value;
    ${binding.startsWith("inline") ? `export const readLocal = () => ${currentRequire}('./relative.cjs').value;` : ""}
  `,
    );
    const artifact = capturePluginGenerationArtifact(source, entry);
    cleanups.push(artifact.dispose);
    expect(artifact.hasSource(path.join(source, "private.txt"))).toBe(false);
    expect(artifact.hasSource(path.join(source, "node_modules/label-dependency/index.cjs"))).toBe(
      false,
    );
    fs.writeFileSync(
      path.join(source, "node_modules/owner-dependency/index.cjs"),
      "exports.value = 'after';",
    );
    fs.writeFileSync(path.join(source, "relative.cjs"), 'exports.value = "relative-after";');
    const host = createArtifactLoader(artifact);
    const plugin = host(artifact.resolve(entry)) as { read(): string; readLocal?(): string };
    expect(plugin.read()).toBe("before");
    if (binding.startsWith("inline")) {
      expect(plugin.readLocal?.()).toBe("relative-before");
    }
  },
);

it("retains selective package scopes and npm aliases without sweeping unused inputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-package-imports-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const dependency = path.join(root, "dependency");
  fs.mkdirSync(path.join(source, "node_modules", "unused-dependency"), { recursive: true });
  fs.mkdirSync(path.join(source, "nested"));
  fs.mkdirSync(path.join(source, "inside", "node_modules", "first-alias"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "inside", "node_modules", "first-alias", "package.json"),
    '{"name":"decoy","main":"index.cjs"}',
  );
  fs.writeFileSync(
    path.join(source, "inside", "node_modules", "first-alias", "index.cjs"),
    'exports.value = "wrong-scope";',
  );
  fs.writeFileSync(
    path.join(source, "inside", "use.mjs"),
    "export { default as external } from '#first';",
  );
  fs.mkdirSync(dependency);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "source-package",
      type: "module",
      exports: { "./self": "./self.mjs" },
      imports: {
        "#local": "./local.mjs",
        "#conditional": { import: "./import.mjs", require: "./require.cjs" },
        "#first": "first-alias",
        "#second": "second-alias",
        "#unused": "unused-dependency",
      },
      dependencies: {
        "first-alias": "npm:actual-package-name@1.0.0",
        "second-alias": "npm:actual-package-name@1.0.0",
        "unused-dependency": "1.0.0",
        "absent-unused-declaration": "1.0.0",
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, "nested", "package.json"),
    JSON.stringify({ type: "module", imports: { "#nested": "./value.mjs" } }),
  );
  fs.writeFileSync(
    path.join(source, "node_modules", "unused-dependency", "package.json"),
    '{"name":"unused-dependency","main":"index.cjs"}',
  );
  fs.writeFileSync(
    path.join(source, "node_modules", "unused-dependency", "index.cjs"),
    'exports.value = "unused";',
  );
  fs.writeFileSync(path.join(source, "private.txt"), "not a captured input");
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    '{"name":"actual-package-name","version":"1.0.0","main":"index.cjs"}',
  );
  for (const alias of ["first-alias", "second-alias"]) {
    const link = path.join(source, "node_modules", alias);
    fs.symlinkSync(path.relative(path.dirname(link), dependency), link, "junction");
  }
  const entry = path.join(source, "entry.mjs");
  fs.writeFileSync(
    entry,
    `import { createRequire } from 'node:module';
    import { value as local } from '#local'; import { value as imported } from '#conditional';
    import { value as self } from 'source-package/self'; import { value as nested } from './nested/use.mjs';
    import first from '#first'; import second from '#second'; import { external } from './inside/use.mjs';
    const require = createRequire(import.meta.url);
    export const read = () => [local, imported, require('#conditional').value, self, nested,
      first.value, second.value, first === second, require('#first') === first, external === first];`,
  );
  fs.writeFileSync(path.join(source, "nested", "use.mjs"), "export { value } from '#nested';");
  const write = (version: string) => {
    for (const name of ["local", "import", "self"]) {
      fs.writeFileSync(
        path.join(source, `${name}.mjs`),
        `export const value = '${name}-${version}';`,
      );
    }
    fs.writeFileSync(path.join(source, "require.cjs"), `exports.value = 'require-${version}';`);
    fs.writeFileSync(
      path.join(source, "nested", "value.mjs"),
      `export const value = 'nested-${version}';`,
    );
    fs.writeFileSync(
      path.join(dependency, "index.cjs"),
      `exports.value = 'dependency-${version}';`,
    );
  };
  write("before");
  const artifact = capturePluginGenerationArtifact(source, entry);
  cleanups.push(artifact.dispose);
  write("after");
  const host = createArtifactLoader(artifact);
  const plugin = await host.import<{ read(): unknown[] }>(artifact.resolve(entry));
  expect(plugin.read()).toEqual([
    "local-before",
    "import-before",
    "require-before",
    "self-before",
    "nested-before",
    "dependency-before",
    "dependency-before",
    true,
    true,
    true,
  ]);
  expect(artifact.hasSource(path.join(source, "private.txt"))).toBe(false);
  expect(
    artifact.hasSource(path.join(source, "node_modules", "unused-dependency", "index.cjs")),
  ).toBe(false);
});

it.each([
  ["require.resolve", "fs.readFileSync(require.resolve('./schema.json'), 'utf8')"],
  [
    "import.meta.resolve",
    "readFileSync(new FileURL(import.meta.resolve('./schema.json')), 'utf8')",
  ],
  ["named join", "readFileSync(join(__dirname, 'schema.json'), 'utf8')"],
  ["named resolve", "readFileSync(resolve(__dirname, 'schema.json'), 'utf8')"],
  [
    "import.meta.dirname typed literal",
    "readFileSync(join(import.meta.dirname as string, 'schema.json' as const), 'utf8')",
  ],
  ["template asset", "readFileSync(join(__dirname, `schema.json`), 'utf8')"],
  ["imported URL", "readFileSync(new FileURL('./schema.json', import.meta.url), 'utf8')"],
])(
  "captures standalone imports and assets via %s without owning its workspace",
  async (_name, read) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-file-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    const socket = process.platform === "win32" ? undefined : net.createServer();
    if (socket) {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(path.join(source, "socket"), resolve);
      });
    }
    try {
      fs.writeFileSync(path.join(source, "unrelated.txt"), "private workspace content");
      fs.mkdirSync(path.join(source, "unrelated"));
      fs.writeFileSync(path.join(source, "unrelated", "private.txt"), "private workspace content");
      fs.writeFileSync(
        path.join(source, "index.ts"),
        `import { Buffer as token } from 'node:buffer'; export { token };
       export const description = './unrelated'; export const read = async () => (await import('./helper.js')).read();`,
      );
      fs.writeFileSync(
        path.join(source, "helper.ts"),
        `import fs, { readFileSync } from 'node:fs';
       import { join, resolve } from 'node:path';
       import { URL as FileURL } from 'node:url';
       const unrelated = { resolve: (value: string) => value };
       export const label = unrelated.resolve('./unrelated.txt');
       export const read = () => [
         fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8'),
         ${read},
       ];`,
      );
      fs.writeFileSync(path.join(source, "asset.txt"), "before");
      fs.writeFileSync(path.join(source, "schema.json"), '{"version":"before"}');
      const entry = path.join(source, "index.ts");
      const captured = capturePluginGenerationArtifact(source, entry);
      cleanups.push(captured.dispose);
      const token = Buffer;
      const host = createArtifactLoader(captured);
      const plugin = host(captured.resolve(entry)) as {
        read(): Promise<string[]>;
        token: unknown;
      };
      expect(plugin.token).toBe(token);
      fs.writeFileSync(path.join(source, "asset.txt"), "after");
      fs.writeFileSync(path.join(source, "schema.json"), '{"version":"after"}');
      fs.writeFileSync(
        path.join(source, "helper.ts"),
        `export const read = () => 'changed helper';`,
      );
      await expect(plugin.read()).resolves.toEqual(["before", '{"version":"before"}']);
      expect(fs.readdirSync(captured.rootDir).toSorted()).toEqual([
        "asset.txt",
        "helper.ts",
        "index.ts",
        "schema.json",
      ]);
      expect(captured.hasSource(path.join(source, "unrelated.txt"))).toBe(false);
    } finally {
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          socket.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  },
);

it("does not capture the discarded prefix of an absolute path.resolve asset", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-resolve-"));
  cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
  const external = path.join(source, "external.txt");
  const pluginRoot = path.join(source, "plugin");
  const misleading = path.join(pluginRoot, "discarded", external);
  fs.mkdirSync(path.dirname(misleading), { recursive: true });
  fs.writeFileSync(misleading, "must not capture");
  fs.writeFileSync(external, "before");
  const entry = path.join(pluginRoot, "index.cjs");
  fs.writeFileSync(
    entry,
    `const fs = require('node:fs'); const path = require('node:path');
     exports.read = () => fs.readFileSync(path.resolve(__dirname, 'discarded', ${JSON.stringify(external)}), 'utf8');`,
  );
  const artifact = capturePluginGenerationArtifact(pluginRoot, entry);
  cleanups.push(artifact.dispose);
  const host = createArtifactLoader(artifact);
  const plugin = host(artifact.resolve(entry)) as { read(): string };
  fs.writeFileSync(external, "after");
  expect(plugin.read()).toBe("after");
  expect(artifact.hasSource(misleading)).toBe(false);
});

it("captures helpers, assets and npm packages with builtin names for each reload and releases captured files", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-"));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "punycode");
  const dependency = path.join(source, "node_modules", "punycode");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ dependencies: { punycode: "1.0.0" } }),
  );
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "punycode", exports: { "./fixture": "./value.js" } }),
  );
  fs.writeFileSync(
    path.join(source, "index.ts"),
    `import { value } from './helper.ts'; import { dependency } from 'punycode/fixture';
     export const read = async () => [value, (await import('./lazy.js')).read(), dependency];`,
  );
  fs.writeFileSync(path.join(source, "helper.js"), `export const value = 'stale build';`);
  fs.writeFileSync(
    path.join(source, "lazy.ts"),
    `import fs from 'node:fs'; export const read = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');`,
  );
  const load = (value: string) => {
    fs.writeFileSync(path.join(source, "helper.ts"), `export const value = '${value}';`);
    fs.writeFileSync(path.join(source, "asset.txt"), value);
    fs.writeFileSync(path.join(dependency, "value.js"), `exports.dependency = '${value}';`);
    const artifact = capturePluginGenerationArtifact(source);
    cleanups.push(artifact.dispose);
    const host = createArtifactLoader(artifact);
    const plugin = host(artifact.resolve(path.join(source, "index.ts"))) as {
      read: () => Promise<string[]>;
    };
    return { artifact, host, plugin };
  };
  const a = load("A");
  const b = load("B");
  await expect(a.plugin.read()).resolves.toEqual(["A", "A", "A"]);
  await expect(b.plugin.read()).resolves.toEqual(["B", "B", "B"]);
  expect(a.artifact.sourceDigest).not.toBe(b.artifact.sourceDigest);
  fs.rmSync(source, { recursive: true });
  expect(b.artifact.resolve(path.join(source, "lazy.ts"))).toBe(
    path.join(b.artifact.rootDir, "lazy.ts"),
  );
  a.artifact.dispose();
  expect(fs.existsSync(a.artifact.boundaryRoot)).toBe(false);
  await expect(b.plugin.read()).resolves.toEqual(["B", "B", "B"]);
});
