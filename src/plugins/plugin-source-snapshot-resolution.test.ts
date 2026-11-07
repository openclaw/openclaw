import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSourceSnapshotEntry } from "./plugin-source-snapshot-entries.js";
import { collectPluginSnapshotMetadata } from "./plugin-source-snapshot-metadata.js";
import { selectPluginSnapshotPackageMap } from "./plugin-source-snapshot-package-map.js";
import {
  createPluginSnapshotResolver,
  type PluginSnapshotResolutionSource,
} from "./plugin-source-snapshot-resolution.js";

const root = path.resolve("snapshot-resolution-fixture");
function fixture() {
  const entries = new Map<string, { kind: "file" | "directory" | "link" }>();
  const resolution = new Map<string, string>();
  const configuration = new Map<string, string>();
  const sourceLinks = new Map<string, string>();
  const source: PluginSnapshotResolutionSource = {
    rootDir: path.join(root, "plugin"),
    payloadRoot: root,
    entries,
    resolution,
    configuration,
    sourceLinks,
    sourceAliases: { [path.resolve("installed-plugin")]: path.join(root, "plugin") },
  };
  const add = (relative: string, kind: "file" | "directory" | "link" = "file") => {
    const filename = path.join(root, relative);
    entries.set(filename, { kind });
    for (
      let parent = path.dirname(filename);
      parent.startsWith(root);
      parent = path.dirname(parent)
    ) {
      entries.set(parent, { kind: "directory" });
      if (parent === root) {
        break;
      }
    }
    return filename;
  };
  const pkg = (relative: string, value: unknown) => {
    const directory = path.join(root, relative);
    add(path.join(relative, "package.json"));
    resolution.set(directory, JSON.stringify(value));
    return directory;
  };
  const config = (relative: string, value: string) => {
    const filename = add(relative);
    configuration.set(filename, value);
    return filename;
  };
  return { source, add, pkg, config, sourceLinks };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("authenticated snapshot resolution", () => {
  it("selects import/require, self, imports and patterned package targets without filesystem probes", () => {
    const f = fixture();
    const importer = f.add("plugin/index.mjs");
    f.pkg("plugin", {
      name: "self",
      exports: { "./entry": "./self.mjs" },
      imports: { "#dep": "dep" },
    });
    f.add("plugin/self.mjs");
    const dependency = f.pkg("plugin/node_modules/dep", {
      exports: { ".": { import: "./esm.mjs", require: "./cjs.cjs" }, "./feature/*": "./lib/*.mjs" },
    });
    f.add("plugin/node_modules/dep/esm.mjs");
    f.add("plugin/node_modules/dep/cjs.cjs");
    f.add("plugin/node_modules/dep/lib/a.mjs");
    const resolver = createPluginSnapshotResolver(f.source);
    for (const method of [
      "readFileSync",
      "statSync",
      "lstatSync",
      "realpathSync",
      "existsSync",
    ] as const) {
      vi.spyOn(fs, method).mockImplementation(() => {
        throw new Error(`unexpected filesystem ${method}`);
      });
    }
    expect(resolver.resolve(importer, "dep", ["node", "import"]).filename).toBe(
      path.join(dependency, "esm.mjs"),
    );
    expect(resolver.resolve(importer, "dep", ["node", "require"]).filename).toBe(
      path.join(dependency, "cjs.cjs"),
    );
    expect(resolver.resolve(importer, "#dep", ["node", "import"]).filename).toBe(
      path.join(dependency, "esm.mjs"),
    );
    expect(resolver.resolve(importer, "dep/feature/a", ["node", "import"]).filename).toBe(
      path.join(dependency, "lib/a.mjs"),
    );
    expect(resolver.resolve(importer, "self/entry", ["node", "import"]).filename).toBe(
      path.join(root, "plugin/self.mjs"),
    );
  });

  it.each(["#sdk", "sdk-alias"])(
    "preserves admitted %s targets without admitting their direct URLs",
    (request) => {
      const f = fixture();
      const importer = f.add("plugin/index.mjs");
      f.pkg("plugin", { imports: { "#sdk": "openclaw/plugin-sdk/foo" } });
      const external = pathToFileURL(path.resolve("host-sdk/foo.cjs")).href;
      const resolver = createPluginSnapshotResolver(f.source, {
        alias: { "sdk-alias": "openclaw/plugin-sdk/foo" },
        resolveHostModule: (specifier) =>
          specifier === "openclaw/plugin-sdk/foo" ? external : undefined,
      });
      for (const mode of ["require", "import"]) {
        expect(resolver.resolve(importer, request, [mode], true)).toMatchObject({
          url: external,
          external: true,
        });
        expect(() => resolver.resolve(importer, external, [mode], true)).toThrow(
          expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
        );
      }
    },
  );

  it("keeps builtin aliases external in both module modes", () => {
    const f = fixture();
    const importer = f.add("plugin/index.cjs");
    const resolver = createPluginSnapshotResolver(f.source, {
      alias: { "path-alias": "node:path" },
    });
    for (const mode of ["require", "import"]) {
      expect(resolver.resolve(importer, "path-alias", [mode], true)).toMatchObject({
        url: "node:path",
        external: true,
      });
    }
  });

  it("keeps absent first array targets absent and rejects dependencies outside the sealed membership", () => {
    const f = fixture();
    const importer = f.add("plugin/index.cjs");
    f.pkg("plugin/node_modules/dep", { exports: ["./missing.cjs", "./present.cjs"] });
    f.add("plugin/node_modules/dep/present.cjs");
    const resolver = createPluginSnapshotResolver(f.source);
    expect(() => resolver.resolve(importer, "dep", ["require"])).toThrow(
      expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
    );
    expect(() => resolver.resolve(importer, "uninstalled", ["require"])).toThrow(
      /Declare the dependency and reinstall/,
    );
    expect(() =>
      resolver.resolve(path.resolve("elsewhere/anchor.cjs"), "./module.cjs", ["require"]),
    ).toThrow(expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }));
    expect(
      resolver.resolve(path.resolve("elsewhere/anchor.cjs"), importer, ["require"]).filename,
    ).toBe(importer);
  });

  it("retains the logical link path while canonicalizing cache identity and URL suffixes", () => {
    const f = fixture();
    const importer = f.add("plugin/index.mjs");
    f.add("dependencies/dep/entry.mjs");
    f.pkg("dependencies/dep", { exports: "./entry.mjs" });
    const link = f.add("plugin/node_modules/dep", "link");
    f.sourceLinks.set(link, path.join(root, "dependencies/dep"));
    const resolver = createPluginSnapshotResolver(f.source);
    const target = resolver.resolve(importer, "dep", ["import"]);
    expect(target.filename).toBe(path.join(link, "entry.mjs"));
    expect(target.canonical).toBe(path.join(root, "dependencies/dep/entry.mjs"));
    expect(resolver.resolve(importer, "./index.mjs?one#two", ["import"]).url).toBe(
      pathToFileURL(importer).href + "?one#two",
    );
    expect(
      resolver.resolve(importer, path.resolve("installed-plugin/index.mjs"), ["require"]).canonical,
    ).toBe(importer);
  });

  it("uses captured TypeScript config/extends and aliases, while native ESM requires exact files", () => {
    const f = fixture();
    const importer = f.add("plugin/src/index.ts");
    const helper = f.add("plugin/lib/helper.ts");
    f.config(
      "plugin/tsconfig.json",
      '{"extends":"./base", "compilerOptions":{"paths":{"@lib/*":["lib/*"]}}}',
    );
    f.config("plugin/base.json", '{// captured configuration\n"compilerOptions":{"baseUrl":"."}}');
    const resolver = createPluginSnapshotResolver(f.source, {
      tsconfigPaths: true,
      alias: { alias: path.join(root, "plugin/lib") },
    });
    expect(resolver.resolve(importer, "@lib/helper", ["import"]).filename).toBe(helper);
    expect(resolver.resolve(importer, "alias/helper", ["require"]).filename).toBe(helper);
    expect(resolver.resolve(importer, "../lib/helper.js", ["import"]).filename).toBe(helper);
    expect(() => resolver.resolve(importer, "../lib/helper", ["import"], true)).toThrow(
      expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
    );
  });
});

it("applies a child baseUrl override to inherited path mappings", () => {
  const f = fixture();
  const importer = f.add("plugin/index.cjs");
  f.add("plugin/old/value.cjs");
  const expected = f.add("plugin/new/value.cjs");
  f.config(
    "plugin/base.json",
    '{"compilerOptions":{"baseUrl":"./old","paths":{"@value":["value.cjs"]}}}',
  );
  f.config(
    "plugin/tsconfig.json",
    '{"extends":"./base.json","compilerOptions":{"baseUrl":"./new"}}',
  );
  const resolver = createPluginSnapshotResolver(f.source, { tsconfigPaths: true });
  expect(resolver.resolve(importer, "@value", ["require"]).canonical).toBe(expected);
});

it("resolves a linked package's hoisted dependency from its canonical ancestry", () => {
  const f = fixture();
  const logical = f.add("plugin/node_modules/a", "link");
  f.sourceLinks.set(logical, f.pkg("package-1/node_modules/a", { main: "index.cjs" }));
  f.add("package-1/node_modules/a/index.cjs");
  f.pkg("package-1/node_modules/b", { main: "index.cjs" });
  const expected = f.add("package-1/node_modules/b/index.cjs");
  const resolver = createPluginSnapshotResolver(f.source);
  expect(resolver.resolve(path.join(logical, "index.cjs"), "b", ["require"]).canonical).toBe(
    expected,
  );
});

it.each([
  ["@config/base", { tsconfig: "configs/base.json" }],
  ["@config/base", { exports: { ".": { types: "./configs/base.json" } } }],
  ["@config/base/configs/base", {}],
])("captures and follows package config %s through a dependency link", (base, metadata) => {
  const f = fixture();
  const importer = f.add("plugin/index.cjs");
  const expected = f.add("plugin/value.cjs");
  f.config("plugin/tsconfig.json", JSON.stringify({ extends: base }));
  f.pkg("packages/config", metadata);
  f.config("packages/config/configs/base.json", '{"extends":"./paths.json"}');
  f.config(
    "packages/config/configs/paths.json",
    '{"compilerOptions":{"baseUrl":"../../../plugin","paths":{"@value":["value.cjs"]}}}',
  );
  const link = f.add("plugin/node_modules/@config/base", "link");
  f.sourceLinks.set(link, path.join(root, "packages/config"));
  const text = new Map([
    ...f.source.configuration,
    ...Array.from(
      f.source.resolution,
      ([key, value]) => [path.join(key, "package.json"), value] as const,
    ),
  ]);
  const entries = Array.from(f.source.entries, ([filename, entry]): PluginSourceSnapshotEntry => {
    const common = { path: path.relative(root, filename), identity: "fixture" };
    if (entry.kind === "file") {
      return { ...common, kind: "file", contentHash: "fixture", sizeBytes: 0, mode: 0o600 };
    }
    if (entry.kind === "link") {
      return { ...common, kind: "link", target: path.relative(root, f.sourceLinks.get(filename)!) };
    }
    return { ...common, kind: "directory" };
  });
  const captured = collectPluginSnapshotMetadata(entries, (entry) =>
    text.get(path.join(root, entry.path))!,
  );
  f.source.configuration = new Map(
    Object.entries(captured.configuration).map(([key, value]) => [path.join(root, key), value]),
  );
  expect(
    createPluginSnapshotResolver(f.source, { tsconfigPaths: true }).resolve(importer, "@value", [
      "require",
    ]).canonical,
  ).toBe(expected);
});

it("uses captured case for Windows members, aliases, links and metadata", () => {
  const f = fixture();
  const importer = f.add("plugin/index.cjs");
  const expected = f.add("Packages/Dependency/Entry.cjs");
  f.pkg("Packages/Dependency", { main: "Entry.cjs" });
  const link = f.add("plugin/node_modules/Dependency", "link");
  f.sourceLinks.set(link, path.join(root, "Packages/Dependency"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const resolver = createPluginSnapshotResolver(f.source);
    expect(resolver.resolve(importer.toUpperCase(), "dependency", ["require"])).toMatchObject({
      canonical: expected,
      filename: path.join(link, "Entry.cjs"),
    });
    expect(
      resolver.resolve(importer, path.resolve("INSTALLED-PLUGIN/INDEX.CJS"), ["require"]).canonical,
    ).toBe(importer);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("preserves Jiti fallback extension order, typed JSX, and explicit overrides", () => {
  vi.stubEnv("JITI_JSX", "1");
  vi.stubEnv("JITI_EXTENSIONS", undefined);
  const f = fixture();
  const importer = f.add("plugin/index.cjs");
  const jsx = f.add("plugin/view.jsx");
  const mtsx = f.add("plugin/typed.mtsx");
  const ctsx = f.add("plugin/typed.ctsx");
  const mjs = f.add("plugin/ordered.mjs");
  f.add("plugin/ordered.ts");
  const resolve = (request: string) =>
    createPluginSnapshotResolver(f.source).resolve(importer, request, ["require"]).canonical;
  expect(resolve("./view")).toBe(jsx);
  expect(resolve("./typed")).toBe(mtsx);
  expect(resolve("./ordered")).toBe(mjs);
  vi.stubEnv("JITI_EXTENSIONS", '[".ctsx", ".mtsx"]');
  expect(resolve("./typed")).toBe(ctsx);
  expect(
    createPluginSnapshotResolver(f.source, { extensions: [".mtsx"] }).resolve(importer, "./typed", [
      "require",
    ]).canonical,
  ).toBe(mtsx);
  expect(() =>
    createPluginSnapshotResolver(f.source, { extensions: [".mtsx"] }).resolve(importer, "./view", [
      "require",
    ]),
  ).toThrow(expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }));
});

it.each(["node", "bun"] as const)(
  "prefers %s native addon/file resolution before Jiti fallback",
  (runtime) => {
    const f = fixture();
    const importer = f.add("plugin/index.cjs");
    const addon = f.add("plugin/choice.node");
    const mjs = f.add("plugin/choice.mjs");
    const resolver = createPluginSnapshotResolver(f.source, { runtime });
    expect(resolver.resolve(importer, "./choice", ["require"]).canonical).toBe(
      runtime === "node" ? addon : mjs,
    );
  },
);

it.each([
  ["entry.js", "entry.ts"],
  ["./start", "start.ts"],
  ["./start", "start.mjs"],
])("falls back from missing package main %s to index before %s", (main, fallback) => {
  const f = fixture();
  const importer = f.add("plugin/index.mjs");
  f.pkg("plugin/node_modules/legacy", { main });
  f.add(`plugin/node_modules/legacy/${fallback}`);
  const expected = f.add("plugin/node_modules/legacy/index.js");
  for (const runtime of ["node", "bun"] as const) {
    const resolver = createPluginSnapshotResolver(f.source, { runtime });
    for (const native of [false, true]) {
      for (const mode of ["import", "require"]) {
        expect(resolver.resolve(importer, "legacy", [mode], native).canonical).toBe(expected);
      }
    }
  }
});

describe("package map selection", () => {
  const select = (map: unknown, request = ".", runtime: "node" | "bun" = "node") =>
    selectPluginSnapshotPackageMap(map, {
      packageDir: root,
      request,
      conditions: new Set(["node", "import"]),
      internal: false,
      runtime,
      resolvePackage: () => {
        throw new Error("unexpected package target");
      },
    });
  it("distinguishes null blocking from unmatched condition fallthrough and array fallback", () => {
    expect(
      fileURLToPath(select({ import: { unknown: "./wrong.js" }, default: "./right.js" })),
    ).toBe(path.join(root, "right.js"));
    expect(() => select({ import: null, default: "./right.js" })).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(fileURLToPath(select(["../invalid.js", null, "./right.js"]))).toBe(
      path.join(root, "right.js"),
    );
    expect(() => select([null, "../invalid.js"])).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_PACKAGE_TARGET" }),
    );
  });
  it("rejects ambiguous maps, integer conditions, encoded traversal and URL exports", () => {
    for (const map of [
      { ".": "./right.js", import: "./wrong.js" },
      { "0": "./wrong.js", default: "./right.js" },
    ]) {
      expect(() => select(map)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_PACKAGE_CONFIG" }),
      );
    }
    for (const target of [
      "file:///outside.js",
      "./%2e%2e/outside.js",
      "./node%5fmodules/evil.js",
    ]) {
      expect(() => select(target)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_PACKAGE_TARGET" }),
      );
    }
    expect(() => select("./x%2fy.js")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_MODULE_SPECIFIER" }),
    );
  });
  it("uses the most specific pattern and preserves Bun's empty pattern match", () => {
    expect(
      fileURLToPath(select({ "./*": "./wrong.js", "./lib/*": "./lib/*.js" }, "./lib/helper")),
    ).toBe(path.join(root, "lib/helper.js"));
    expect(() => select({ "./lib/*": "./right.js" }, "./lib/")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(fileURLToPath(select({ "./lib/*": "./right.js" }, "./lib/", "bun"))).toBe(
      path.join(root, "right.js"),
    );
  });
});
