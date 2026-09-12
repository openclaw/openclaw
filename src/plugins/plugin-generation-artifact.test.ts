import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { createJiti } from "jiti";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

// Artifact tests evaluate captured bytes independently; managed Node execution has binder suites.
function createArtifactLoader(artifact: ReturnType<typeof capturePluginGenerationArtifact>) {
  return createJiti(artifact.rootDir, { fsCache: false, moduleCache: false, tryNative: false });
}

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it.each(["empty", "nested/empty", ".git/empty", "node_modules/unused"])(
  "captures directory layout in source receipts while excluding %s when appropriate",
  (directory) => {
    const source = temp.make("plugin-layout-digest-");
    fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 1;");
    const capture = () => {
      const artifact = capturePluginGenerationArtifact(source);
      cleanups.push(artifact.dispose);
      return artifact;
    };
    const before = capture();
    fs.mkdirSync(path.join(source, directory), { recursive: true });
    const after = capture();
    const included = !directory.startsWith(".git/") && !directory.startsWith("node_modules/");
    expect(fs.existsSync(path.join(before.rootDir, directory))).toBe(false);
    expect(fs.existsSync(path.join(after.rootDir, directory))).toBe(included);
    expect(after.sourceDigest === before.sourceDigest).toBe(!included);
    expect(capture().sourceDigest).toBe(after.sourceDigest);
    fs.rmSync(path.join(source, directory.split("/")[0]!), { recursive: true });
    expect(capture().sourceDigest).toBe(before.sourceDigest);
  },
);

it.each([
  "dependency",
  "directory",
  "root",
  "entry before demand",
  "entry after demand",
  "demanded module",
])("retains the original source identity check after copy disposal: %s", (change) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-check-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "plugin");
  const dependency = path.join(source, "node_modules", "fixture");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ dependencies: { fixture: "1.0.0" } }),
  );
  const entry = path.join(source, "index.ts");
  const demanded = path.join(source, "demanded.js");
  const capturesOnDemand = change.includes("demand");
  fs.writeFileSync(entry, "export { value } from 'fixture';");
  fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"fixture","main":"index.js"}');
  fs.writeFileSync(path.join(dependency, "index.js"), "exports.value = 1;");
  if (capturesOnDemand) {
    fs.writeFileSync(demanded, "exports.value = 1;");
  }
  const artifact = capturePluginGenerationArtifact(source, capturesOnDemand ? entry : undefined);
  cleanups.push(artifact.dispose);
  if (change === "entry before demand") {
    fs.appendFileSync(entry, "\nexport const edited = true;");
  }
  if (capturesOnDemand) {
    const initialDigest = artifact.sourceDigest;
    const captured = artifact.captureModule(artifact.resolve(entry), "./demanded.js", [
      "node",
      "require",
    ]);
    expect(captured).toMatchObject({ target: expect.any(URL) });
    expect(fs.readFileSync(artifact.resolve(demanded), "utf8")).toBe("exports.value = 1;");
    expect(artifact.sourceDigest).toBe(initialDigest);
  }
  artifact.dispose();
  if (change !== "entry before demand") {
    expect(artifact.assertSourceCurrent).not.toThrow();
  }
  if (change === "root") {
    fs.renameSync(source, path.join(root, "original"));
    fs.mkdirSync(source);
  } else if (change === "directory") {
    fs.writeFileSync(path.join(source, "added.ts"), "export const added = true;");
  } else if (change === "entry after demand") {
    fs.appendFileSync(entry, "\nexport const edited = true;");
  } else if (change === "demanded module") {
    fs.writeFileSync(demanded, "exports.value = 2;");
  } else if (change === "dependency") {
    fs.writeFileSync(path.join(dependency, "index.js"), "exports.value = 2;");
  }
  expect(artifact.assertSourceCurrent).toThrow();
});

it.each(
  ["prepare", "capture"].flatMap((acquisition) =>
    ["manifest", "entry", "body"].map((change) => ({ acquisition, change })),
  ),
)("retains $change identity after package $acquisition and disposal", ({ acquisition, change }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-package-identity-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dependency = path.join(root, "node_modules", "fixture");
  fs.mkdirSync(dependency, { recursive: true });
  const manifest = path.join(dependency, "package.json");
  const dependencyEntry = path.join(dependency, "index.cjs");
  const body = path.join(dependency, "body.cjs");
  const entry = path.join(root, "index.cjs");
  fs.writeFileSync(path.join(root, "package.json"), '{"imports":{"#selected":"fixture"}}');
  fs.writeFileSync(entry, "exports.read = name => require(name);");
  fs.writeFileSync(manifest, '{"main":"index.cjs"}');
  fs.writeFileSync(dependencyEntry, "exports.value = require('./body.cjs');");
  fs.writeFileSync(body, "module.exports = 'initial body';");
  const artifact = capturePluginGenerationArtifact(root, entry);
  cleanups.push(artifact.dispose);
  const initialDigest = artifact.sourceDigest;
  const capturedDependency = expectDefined(
    artifact.sourceAliases[dependency],
    "dependency capture",
  );
  if (change === "manifest") {
    fs.writeFileSync(manifest, '{"main":"replacement.cjs"}');
  } else if (change === "entry") {
    fs.writeFileSync(dependencyEntry, "exports.value = 'replaced entry';");
  }
  fs.writeFileSync(body, "module.exports = 'first demand';");
  if (acquisition === "prepare") {
    artifact.prepareModule(path.join(capturedDependency, "index.cjs"));
  } else {
    expect(
      artifact.captureModule(artifact.resolve(entry), "#selected", ["node", "require"]),
    ).toMatchObject({ retryNative: true });
  }
  expect(fs.readFileSync(path.join(capturedDependency, "package.json"), "utf8")).toBe(
    '{"main":"index.cjs"}',
  );
  expect(fs.readFileSync(path.join(capturedDependency, "index.cjs"), "utf8")).toBe(
    "exports.value = require('./body.cjs');",
  );
  expect(fs.readFileSync(path.join(capturedDependency, "body.cjs"), "utf8")).toBe(
    "module.exports = 'first demand';",
  );
  expect(artifact.sourceDigest).toBe(initialDigest);
  artifact.dispose();
  if (change === "body") {
    expect(artifact.assertSourceCurrent).not.toThrow();
    fs.writeFileSync(body, "module.exports = 'later body';");
  }
  expect(artifact.assertSourceCurrent).toThrow();
});

it.each(["require", "import"] as const)(
  "preserves optional standalone %s while freezing missing dependencies",
  async (mode) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-optional-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    const entry = path.join(source, "index.cjs");
    const dependencyName = "openclaw-capture-optional-fixture";
    const load =
      mode === "require" ? `require('${dependencyName}')` : `await import('${dependencyName}')`;
    fs.writeFileSync(
      entry,
      mode === "require"
        ? `try { exports.value = ${load}.value; } catch { exports.value = 'fallback'; }
           exports.read = async () => exports.value;
           exports.required = async () => ${load};`
        : `exports.read = async () => {
             try { return (${load}).value; } catch { return 'fallback'; }
           };
           exports.required = async () => ${load};`,
    );
    const capture = () => {
      const artifact = capturePluginGenerationArtifact(source, entry);
      cleanups.push(artifact.dispose);
      const host = createArtifactLoader(artifact);
      return () =>
        host(artifact.resolve(entry)) as {
          read(): Promise<string>;
          required(): Promise<unknown>;
        };
    };
    const loadBeforeInstall = capture();
    const dependency = path.join(source, "node_modules", dependencyName);
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"index.cjs"}');
    fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 'installed';");
    const before = loadBeforeInstall();
    await expect(before.read()).resolves.toBe("fallback");
    await expect(before.required()).rejects.toThrow(dependencyName);
    await expect(capture()().read()).resolves.toBe("installed");
  },
);

it.each([false, true])(
  "keeps authored absolute references on the native source graph (selective: %s)",
  async (selective) => {
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
      const artifact = capturePluginGenerationArtifact(source, selective ? entry : undefined);
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
  },
);

it.each(["dependencies", "optionalDependencies", "peerDependencies"])(
  "retains the missing declared %s capture contract",
  (kind) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-declared-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ [kind]: { "openclaw-capture-missing-fixture": "1.0.0" } }),
    );
    fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 'ready';");
    if (kind === "dependencies") {
      expect(() => capturePluginGenerationArtifact(source)).toThrow(
        "Plugin dependency openclaw-capture-missing-fixture is missing",
      );
    } else {
      const artifact = capturePluginGenerationArtifact(source);
      cleanups.push(artifact.dispose);
      expect(artifact.hasSource(path.join(source, "index.cjs"))).toBe(true);
    }
  },
);

it.each([
  ["named", "import { createRequire as factory } from 'node:module';", "factory", "require"],
  ["alias", "import { createRequire as factory } from 'module';", "factory", "local"],
  [
    "namespace",
    "import * as nativeModule from 'node:module';",
    "nativeModule.createRequire",
    "local",
  ],
  ["default", "import nativeModule from 'node:module';", "nativeModule.createRequire", "local"],
  ["inline", "import { createRequire as factory } from 'node:module';", "factory", "inline"],
  [
    "inline-resolve",
    "import { createRequire as factory } from 'node:module';",
    "factory",
    "inline-resolve",
  ],
  [
    "template",
    "import { createRequire as factory } from 'node:module';",
    "factory",
    "require",
    "`owner-dependency/package.json`",
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
      binding === "inline"
        ? `${currentRequire}('owner-dependency')`
        : binding === "inline-resolve"
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

it.each([
  ["ts", "js"],
  ["tsx", "js"],
  ["mts", "mjs"],
  ["cts", "cjs"],
] as const)(
  "captures the requested JavaScript peer beside a %s source helper",
  (sourceExtension, runtimeExtension) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-suffix-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    const entry = path.join(source, `entry.${sourceExtension}`);
    const helper = path.join(source, `helper.${sourceExtension}`);
    fs.writeFileSync(
      entry,
      `import { value } from './helper.${runtimeExtension}'; export const read = () => value;`,
    );
    fs.writeFileSync(helper, 'export const value: string = "source-before";');
    fs.writeFileSync(
      path.join(source, `helper.${runtimeExtension}`),
      runtimeExtension === "cjs"
        ? 'exports.value = "compiled-stale";'
        : 'export const value = "compiled-stale";',
    );
    const artifact = capturePluginGenerationArtifact(source, entry);
    cleanups.push(artifact.dispose);
    expect(artifact.hasSource(helper)).toBe(false);
    expect(artifact.hasSource(path.join(source, `helper.${runtimeExtension}`))).toBe(true);
    fs.writeFileSync(helper, 'export const value: string = "source-after";');
    const host = createArtifactLoader(artifact);
    expect((host(artifact.resolve(entry)) as { read(): string }).read()).toBe("compiled-stale");
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

it("captures hoisted setup helpers without changing plugin or importer dependency identity", async () => {
  const distribution = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-setup-dist-"));
  cleanups.push(() => fs.rmSync(distribution, { recursive: true, force: true }));
  const boundary = path.join(distribution, "dist");
  const source = path.join(boundary, "extensions", "setup-owner");
  fs.mkdirSync(source, { recursive: true });
  const entry = path.join(source, "setup-api.cjs");
  const helper = path.join(boundary, "setup-helper.cjs");
  const token = Buffer;
  const write = (version: string) => {
    for (const [root, label] of [
      [distribution, "hoisted"],
      [source, "plugin"],
    ] as const) {
      const dependency = path.join(root, "node_modules", "setup-dependency");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"index.cjs"}');
      fs.writeFileSync(
        path.join(dependency, "index.cjs"),
        `exports.value = ${JSON.stringify(`${label}-${version}`)};`,
      );
    }
    fs.writeFileSync(helper, "exports.value = require('setup-dependency').value;");
    fs.writeFileSync(
      entry,
      `exports.read = async () => [
        require('node:buffer').Buffer,
        require('setup-dependency').value,
        (await import('../../setup-helper.cjs')).value
      ];`,
    );
  };
  const capture = () => {
    const artifact = capturePluginGenerationArtifact(source, entry, boundary);
    cleanups.push(artifact.dispose);
    expect(artifact.sourceRoot).toBe(fs.realpathSync(source));
    const host = createArtifactLoader(artifact);
    return host(artifact.resolve(entry)) as { read(): Promise<unknown[]> };
  };
  write("before");
  const first = capture();
  write("after");
  const second = capture();
  await expect(first.read()).resolves.toEqual([token, "plugin-before", "hoisted-before"]);
  await expect(second.read()).resolves.toEqual([token, "plugin-after", "hoisted-after"]);
});

it.each([
  ["require.resolve", "fs.readFileSync(require.resolve('./schema.json'), 'utf8')"],
  [
    "import.meta.resolve",
    "readFileSync(new FileURL(import.meta.resolve('./schema.json')), 'utf8')",
  ],
  ["named join", "readFileSync(join(__dirname, 'schema.json'), 'utf8')"],
  ["named resolve", "readFileSync(resolve(__dirname, 'schema.json'), 'utf8')"],
  ["import.meta.dirname join", "readFileSync(join(import.meta.dirname, 'schema.json'), 'utf8')"],
  [
    "import.meta.dirname resolve",
    "readFileSync(resolve(import.meta.dirname, 'schema.json'), 'utf8')",
  ],
  [
    "import.meta.dirname join alias",
    "readFileSync(assetJoin(import.meta.dirname, 'schema.json'), 'utf8')",
  ],
  [
    "import.meta.dirname resolve alias",
    "readFileSync(assetResolve(import.meta.dirname, 'schema.json'), 'utf8')",
  ],
  [
    "import.meta.dirname typed literal",
    "readFileSync(join(import.meta.dirname as string, 'schema.json' as const), 'utf8')",
  ],
  ["template module", "readFileSync(require.resolve(`./schema.json`), 'utf8')"],
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
       import { join, resolve, join as assetJoin, resolve as assetResolve } from 'node:path';
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

it.each(["plugin", "punycode"])(
  "captures helpers, assets and npm packages with builtin names under %s for each reload and releases captured files",
  async (directoryName) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-"));
    cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const source = path.join(fixture, directoryName);
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
  },
);
