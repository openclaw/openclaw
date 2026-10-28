import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneSourceEntries } from "../../scripts/lib/bun-standalone-source-entries.mjs";
import { createStandaloneSourceGraph } from "../../scripts/lib/bun-standalone-source-graph.mjs";
import { prepareStandaloneWorkers } from "../../scripts/lib/bun-standalone-workers.mjs";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-graph-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  const runtimeRoot = path.join(outputRoot, "runtime");
  const write = (base: string, relative: string, contents: string) => {
    const filename = path.join(base, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  };
  write(sourceRoot, "package.json", '{"type":"module"}\n');
  fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
  return { root, sourceRoot, outputRoot, runtimeRoot, write };
}

function requireFilename(filename: string | undefined) {
  if (!filename) {
    throw new Error("Missing mapped source entry");
  }
  return filename;
}

describe("standalone original-source graph", () => {
  it("keeps checkout-owned context paths stable without changing compiler aliases", () => {
    const capture = (target: string) => {
      const fixtureRoot = fixture();
      const { sourceRoot, write } = fixtureRoot;
      write(sourceRoot, "src/index.ts", "export const value: number = 42;\n");
      write(sourceRoot, "src/helper.ts", "export const value: number = 7;\n");
      write(sourceRoot, "src/other.ts", "export const value: number = 7;\n");
      write(sourceRoot, "tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
      const alias = path.isAbsolute(target) ? target : path.join(sourceRoot, target);
      const config = {
        entry: { entry: "src/index.ts" },
        alias: { "@fixture/helper": alias },
        cwd: sourceRoot,
        tsconfig: path.join(sourceRoot, "tsconfig.json"),
      };
      const original = JSON.stringify(config);
      const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
      const embeddedPaths: Record<string, string> = {};
      const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths });
      graph.addEntry("dist/entry.mjs");
      const context = graph.manifest().contexts[0];
      const entry = sourceEntries.resolve("dist/entry.mjs");
      if (!context || !entry) {
        throw new Error("Missing source context");
      }
      expect(JSON.stringify(config)).toBe(original);
      expect(context.alias["@fixture/helper"]).toBe(alias);
      expect(entry.semanticInputs.alias["@fixture/helper"]).toBe(alias);
      return {
        context: context.id,
        semantic: entry.semanticHash,
        embedded: embeddedPaths["dist/entry.mjs"],
      };
    };
    expect(capture("src/helper.ts")).toEqual(capture("src/helper.ts"));
    expect(capture("src/other.ts")).not.toEqual(capture("src/helper.ts"));
    expect(capture("src/helper.ts?other")).not.toEqual(capture("src/helper.ts?optional-native"));
    expect(capture("/external/shared/helper.ts")).toEqual(capture("/external/shared/helper.ts"));
    expect(capture("/external/other/helper.ts")).not.toEqual(capture("/external/shared/helper.ts"));
  });

  it("shares the application package across synthetic contexts and preserves real child packages", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, runtimeRoot, write } = fixtureRoot;
    const rootPackage = JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/contracts": "./src/plugin-sdk/contracts.ts" },
    });
    write(sourceRoot, "package.json", rootPackage);
    write(runtimeRoot, "package.json", rootPackage);
    write(sourceRoot, "src/index.ts", "export const value: number = 42;\n");
    const childPackage = '{"name":"@fixture/child","type":"module"}\n';
    write(sourceRoot, "packages/child/package.json", childPackage);
    write(sourceRoot, "packages/child/index.ts", "export const value: number = 7;\n");
    const configs: Parameters<typeof createStandaloneSourceEntries>[0]["configs"] = [
      { entry: { first: "src/index.ts" } },
      { entry: { second: "src/index.ts", child: "packages/child/index.ts" } },
    ];
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    graph.addEntry("dist/first.mjs");
    graph.addEntry("dist/second.mjs");
    const child = requireFilename(graph.addEntry("dist/child.mjs"));
    for (const context of graph.contexts.values()) {
      expect(
        JSON.parse(fs.readFileSync(path.join(context.directory, "package.json"), "utf8")),
      ).toEqual({
        type: "module",
      });
    }
    expect(fs.readFileSync(path.join(path.dirname(child), "package.json"), "utf8")).toBe(
      childPackage,
    );
    expect(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8")).toBe(rootPackage);
    expect(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).toBe(rootPackage);
  });

  it("leaves generated sibling worker shims outside the original-source graph", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, runtimeRoot, outputRoot, write } = fixtureRoot;
    write(sourceRoot, "src/index.ts", "export const value: number = 42;\n");
    const config = { entry: { entry: "src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    const workers = prepareStandaloneWorkers({
      runtimeRoot,
      outputRoot,
      workerEntries: [],
      runtimeBootstrap: path.join(outputRoot, "bootstrap.mjs"),
    });
    const entry = path.relative(runtimeRoot, workers.workerThreadsShim);
    expect(graph.addEntry(entry)).toBeUndefined();
    expect(graph.addEntry(workers.workerThreadsShim)).toBeUndefined();
    expect([...graph.roots]).toEqual([]);
    expect(graph.addEntry("dist/entry.mjs")).toBeDefined();
    expect(() => graph.addSource(workers.workerThreadsShim, config)).toThrow(
      "Source input escapes checkout",
    );
  });

  it("stages unchanged TypeScript and its package/config boundaries behind runtime aliases", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, runtimeRoot, outputRoot, write } = fixtureRoot;
    const contents = 'export const label: string = "typed 🦞";\n';
    const source = write(sourceRoot, "packages/example/src/index.ts", contents);
    const rootConfig = '{"compilerOptions":{"strict":true}}\n';
    const packageConfig = '{"extends":"../../tsconfig.json"}\n';
    const packageJson = '{"type":"module","name":"@fixture/example"}\n';
    write(sourceRoot, "tsconfig.json", rootConfig);
    write(sourceRoot, "packages/example/tsconfig.json", packageConfig);
    write(sourceRoot, "packages/example/package.json", packageJson);
    write(
      sourceRoot,
      "packages/example/node_modules/local-types/index.d.ts",
      "export type Id = string;\n",
    );
    write(
      runtimeRoot,
      "packages/example/node_modules/local-types/index.d.ts",
      "export type Id = string;\n",
    );
    const config = { entry: { "example/api": "packages/example/src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const embeddedPaths: Record<string, string> = {};
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths,
    });

    const staged = requireFilename(graph.addEntry("dist/example/api.mjs"));
    expect(fs.readFileSync(staged, "utf8")).toBe(contents);
    expect(fs.readFileSync(source, "utf8")).toBe(contents);
    expect([...graph.roots]).toEqual([staged]);
    const stagedRoot = path.resolve(path.dirname(staged), "../../..");
    expect(fs.readFileSync(path.join(stagedRoot, "tsconfig.json"), "utf8")).toBe(rootConfig);
    expect(fs.readFileSync(path.join(stagedRoot, "packages/example/tsconfig.json"), "utf8")).toBe(
      packageConfig,
    );
    expect(fs.readFileSync(path.join(stagedRoot, "packages/example/package.json"), "utf8")).toBe(
      packageJson,
    );
    const embedded = `/$bunfs/root/${path.relative(outputRoot, staged)}`;
    expect(embeddedPaths["dist/example/api.mjs"]).toBe(embedded);
    const relativeSource = path.relative(runtimeRoot, staged);
    expect(embeddedPaths[relativeSource]).toBe(embedded);
    expect(embeddedPaths[relativeSource.replace(/\.ts$/u, ".js")]).toBe(embedded);
    expect(fs.realpathSync(path.join(stagedRoot, "node_modules"))).toBe(
      path.join(runtimeRoot, "node_modules"),
    );
    expect(fs.realpathSync(path.join(stagedRoot, "packages/example/node_modules"))).toBe(
      path.join(runtimeRoot, "packages/example/node_modules"),
    );
  });

  it("retains distinct plugin closures even when config values and plugin names match", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(sourceRoot, "src/index.ts", "export const value: number = 42;\n");
    const createConfig = (owner: string, name: string) => ({
      entry: { [name]: "src/index.ts" },
      plugins: [{ name: "same-plugin-name", load: () => owner }],
    });
    const first = createConfig("first-owner", "first");
    const second = createConfig("second-owner", "second");
    const sourceEntries = createStandaloneSourceEntries({
      sourceRoot,
      configs: [first, second],
    });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    const firstPath = requireFilename(graph.addEntry("dist/first.mjs"));
    const secondPath = requireFilename(graph.addEntry("dist/second.mjs"));
    expect(secondPath).not.toBe(firstPath);
    expect(graph.resolve({ path: firstPath, importer: "" })).toEqual({ path: firstPath });
    expect(graph.resolve({ path: secondPath, importer: "" })).toEqual({ path: secondPath });
    expect(graph.files.get(firstPath)?.context.config).toBe(first);
    expect(graph.files.get(secondPath)?.context.config).toBe(second);
    expect(graph.files.get(firstPath)?.context.config.plugins[0].load()).toBe("first-owner");
    expect(graph.files.get(secondPath)?.context.config.plugins[0].load()).toBe("second-owner");
    expect(graph.addEntry("dist/first.mjs")).toBe(firstPath);
    expect(fs.lstatSync(firstPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(secondPath).isSymbolicLink()).toBe(false);
    expect(fs.statSync(firstPath).ino).toBe(fs.statSync(path.join(sourceRoot, "src/index.ts")).ino);
    expect(fs.statSync(secondPath).ino).toBe(fs.statSync(firstPath).ino);
    expect(graph.contexts.size).toBe(2);
    expect(graph.roots.size).toBe(2);
  });

  it("preserves nested config inheritance and generated SDK declarations without dist runtime code", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(sourceRoot, "src/gateway/index.ts", "export const value: number = 42;\n");
    write(sourceRoot, "tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
    const extensionConfig =
      '{"extends":"../tsconfig.json","files":["../test/types/ambient.d.ts"]}\n';
    const ambientDeclaration = "interface AmbientContract { value: number }\n";
    write(sourceRoot, "extensions/tsconfig.json", extensionConfig);
    write(sourceRoot, "test/types/ambient.d.ts", ambientDeclaration);
    const gatewayConfig = '{"extends":"../../config/tsconfig/source.json"}\n';
    const inheritedConfig =
      '{"extends":"../../tsconfig.json","compilerOptions":{"useDefineForClassFields":false}}\n';
    write(sourceRoot, "src/gateway/tsconfig.json", gatewayConfig);
    write(sourceRoot, "config/tsconfig/source.json", inheritedConfig);
    write(
      sourceRoot,
      "extensions/tsconfig.package-boundary.paths.json",
      '{"compilerOptions":{"paths":{"openclaw/plugin-sdk/*":["../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts"]}}}\n',
    );
    const declaration = 'export type { Shape } from "./shape.js";\n';
    write(sourceRoot, "packages/plugin-sdk/dist/src/plugin-sdk/index.d.ts", declaration);
    write(
      sourceRoot,
      "packages/plugin-sdk/dist/src/plugin-sdk/shape.d.ts",
      "export interface Shape { value: number }\n",
    );
    write(sourceRoot, "packages/plugin-sdk/dist/esm.d.mts", "export {};\n");
    write(sourceRoot, "packages/plugin-sdk/dist/cjs.d.cts", "export {};\n");
    for (const name of ["runtime.js", "runtime.mjs", "runtime.ts", "index.d.ts.map"]) {
      write(sourceRoot, `packages/plugin-sdk/dist/${name}`, "must not be a type input\n");
    }
    const config = { entry: { gateway: "src/gateway/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    const staged = requireFilename(graph.addEntry("dist/gateway.mjs"));
    const stagedRoot = path.resolve(path.dirname(staged), "../..");
    expect(fs.readFileSync(path.join(stagedRoot, "src/gateway/tsconfig.json"), "utf8")).toBe(
      gatewayConfig,
    );
    expect(fs.readFileSync(path.join(stagedRoot, "config/tsconfig/source.json"), "utf8")).toBe(
      inheritedConfig,
    );
    const stagedExtensionConfig = path.join(stagedRoot, "extensions/tsconfig.json");
    expect(fs.readFileSync(stagedExtensionConfig, "utf8")).toBe(extensionConfig);
    const ambientPath = path.resolve(
      path.dirname(stagedExtensionConfig),
      JSON.parse(fs.readFileSync(stagedExtensionConfig, "utf8")).files[0],
    );
    expect(fs.readFileSync(ambientPath, "utf8")).toBe(ambientDeclaration);
    const sdkRoot = path.join(stagedRoot, "packages/plugin-sdk/dist");
    expect(fs.readFileSync(path.join(sdkRoot, "src/plugin-sdk/index.d.ts"), "utf8")).toBe(
      declaration,
    );
    expect(fs.readFileSync(path.join(sdkRoot, "src/plugin-sdk/shape.d.ts"), "utf8")).toContain(
      "value: number",
    );
    expect(fs.existsSync(path.join(sdkRoot, "esm.d.mts"))).toBe(true);
    expect(fs.existsSync(path.join(sdkRoot, "cjs.d.cts"))).toBe(true);
    for (const name of ["runtime.js", "runtime.mjs", "runtime.ts", "index.d.ts.map"]) {
      expect(fs.existsSync(path.join(sdkRoot, name))).toBe(false);
    }
    expect([...graph.roots]).toEqual([staged]);
    expect(graph.files.size).toBe(1);
  });

  it("checks private plugin declarations with their producer's dependency types", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(
      sourceRoot,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "nodenext",
          target: "esnext",
          types: [],
          preserveSymlinks: true,
          paths: {
            "private-api": ["./.artifacts/extension-package-boundary/plugins/producer/api.d.ts"],
          },
        },
        files: ["src/index.ts"],
      }),
    );
    write(
      sourceRoot,
      "src/index.ts",
      'import { consume } from "private-api";\nconsume(value => { const result: string = value.count; });\n',
    );
    const producerRoot = ".artifacts/extension-package-boundary/plugins/producer";
    write(
      sourceRoot,
      `${producerRoot}/api.d.ts`,
      'import type { Value } from "producer-types";\nexport declare function consume(callback: (value: Value) => void): void;\n',
    );
    write(
      sourceRoot,
      "extensions/producer/node_modules/producer-types/index.d.ts",
      "export interface Value { count: number }\n",
    );
    write(
      sourceRoot,
      "extensions/producer/node_modules/producer-types/package.json",
      '{"name":"producer-types","type":"module","types":"index.d.ts"}\n',
    );
    fs.symlinkSync(
      path.join(sourceRoot, "extensions/producer/node_modules"),
      path.join(sourceRoot, producerRoot, "node_modules"),
      "dir",
    );
    for (const name of ["runtime.js", "source.ts", ".inputs.json"]) {
      write(sourceRoot, `${producerRoot}/${name}`, "not a type input\n");
    }
    const config = { entry: { entry: "src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    const staged = requireFilename(graph.addEntry("dist/entry.mjs"));
    const stagedRoot = path.dirname(path.dirname(staged));
    const stagedProducer = path.join(stagedRoot, producerRoot);
    expect(fs.readFileSync(path.join(stagedProducer, "api.d.ts"), "utf8")).toContain("consume");
    expect(fs.realpathSync(path.join(stagedProducer, "node_modules"))).toBe(
      path.join(sourceRoot, "extensions/producer/node_modules"),
    );
    for (const name of ["runtime.js", "source.ts", ".inputs.json"]) {
      expect(fs.existsSync(path.join(stagedProducer, name))).toBe(false);
    }
    using project = createNativeTypeScriptProject({
      cwd: stagedRoot,
      configFileName: path.join(stagedRoot, "tsconfig.json"),
    });
    const diagnostics = collectNativeTypeScriptDiagnostics(project.project);
    expect(diagnostics.map(({ code }) => code)).toEqual([2322]);
    expect(diagnostics[0]?.text).toContain("number");
    expect([...graph.roots]).toEqual([staged]);
  });

  it("resolves source aliases and dependency code in context while retaining outside packages", () => {
    const fixtureRoot = fixture();
    const { root, sourceRoot, runtimeRoot, write } = fixtureRoot;
    write(sourceRoot, "src/index.ts", 'export { child } from "@fixture/child";\n');
    const child = write(sourceRoot, "src/child.ts", "export const child: number = 7;\n");
    const dependency = write(sourceRoot, "node_modules/dependency/index.js", "export default 1;\n");
    const runtimeDependency = write(
      runtimeRoot,
      "node_modules/dependency/index.js",
      "export default 999;\n",
    );
    const external = write(root, "outside/index.js", "export default 2;\n");
    const config = {
      entry: { entry: "src/index.ts", child: "src/child.ts" },
      alias: { "@fixture": path.join(sourceRoot, "src") },
    };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const resolveSource = (specifier: string) => {
      if (specifier === path.join(sourceRoot, "src/child")) {
        return child;
      }
      if (specifier === "dependency") {
        return dependency;
      }
      if (specifier === "outside") {
        return external;
      }
      throw Object.assign(new Error(`Missing fixture module: ${specifier}`), {
        code: specifier === "missing-bun" ? "ERR_MODULE_NOT_FOUND" : "MODULE_NOT_FOUND",
      });
    };
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource,
    });
    const importer = requireFilename(graph.addEntry("dist/entry.mjs"));
    const resolvedChild = graph.resolve({ path: "@fixture/child", importer });
    expect(resolvedChild?.path).not.toBe(child);
    expect(fs.readFileSync(requireFilename(resolvedChild?.path), "utf8")).toBe(
      "export const child: number = 7;\n",
    );
    const dependencyPath = requireFilename(graph.resolve({ path: "dependency", importer })?.path);
    expect(dependencyPath).not.toBe(dependency);
    expect(dependencyPath).not.toBe(runtimeDependency);
    expect(
      dependencyPath.startsWith(
        path.join(path.dirname(path.dirname(importer)), ".modules/node_modules"),
      ),
    ).toBe(true);
    expect(
      fs
        .lstatSync(path.join(path.dirname(path.dirname(importer)), ".modules/node_modules"))
        .isSymbolicLink(),
    ).toBe(false);
    expect(fs.readFileSync(dependencyPath, "utf8")).toBe("export default 1;\n");
    expect(graph.files.get(dependencyPath)?.source).toBe(dependency);
    expect(graph.files.get(dependencyPath)?.context).toBe(graph.files.get(importer)?.context);
    expect(fs.readFileSync(runtimeDependency, "utf8")).toBe("export default 999;\n");
    expect(graph.resolve({ path: "outside", importer })).toEqual({ path: external });
    expect(graph.resolve({ path: "node:fs", importer })).toBeUndefined();
    expect(graph.resolve({ path: "missing", importer })).toBeUndefined();
    expect(graph.resolve({ path: "missing-bun", importer })).toBeUndefined();
    expect(graph.resolve({ path: path.join(runtimeRoot, "dist/child.mjs"), importer: "" })).toEqual(
      {
        path: resolvedChild?.path,
      },
    );
    expect(() => graph.addSource(external, config)).toThrow("Source input escapes checkout");
  });

  it("keeps type declarations out of the runtime source roots", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(
      sourceRoot,
      "src/index.ts",
      'import type { Shape } from "./shape.js";\nexport type Value = Shape;\n',
    );
    const declaration = write(
      sourceRoot,
      "src/shape.d.ts",
      "export interface Shape { value: string }\n",
    );
    const typeOnlyContents = "export type Unloaded = { enabled: boolean };\n";
    const typeOnlyConfig = '{"compilerOptions":{"strict":true}}\n';
    write(sourceRoot, "src/types/unloaded.ts", typeOnlyContents);
    write(sourceRoot, "src/types/tsconfig.strict.json", typeOnlyConfig);
    const config = { entry: { entry: "src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource: () => declaration,
    });
    const importer = requireFilename(graph.addEntry("dist/entry.mjs"));
    expect(fs.readFileSync(path.join(path.dirname(importer), "shape.d.ts"), "utf8")).toBe(
      "export interface Shape { value: string }\n",
    );
    expect(fs.readFileSync(path.join(path.dirname(importer), "types/unloaded.ts"), "utf8")).toBe(
      typeOnlyContents,
    );
    expect(
      fs.readFileSync(path.join(path.dirname(importer), "types/tsconfig.strict.json"), "utf8"),
    ).toBe(typeOnlyConfig);
    expect(graph.resolve({ path: "./shape.js", importer })).toEqual({ path: declaration });
    expect(fs.lstatSync(path.join(path.dirname(importer), "types")).isSymbolicLink()).toBe(true);
    expect([...graph.roots]).toEqual([importer]);
    expect([...graph.files.values()].map((file) => file.source)).toEqual([
      path.join(sourceRoot, "src/index.ts"),
    ]);
  });

  it("preserves generated database types and root runtime helpers for type-only lookup", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(
      sourceRoot,
      "src/agents/index.ts",
      'import type { DB } from "../state/db.generated.js";\nimport "../../worker-heap-flag.mjs";\nexport type Tables = keyof DB;\n',
    );
    write(
      sourceRoot,
      "src/state/db.generated.ts",
      'export type * from "../../.artifacts/kysely/db.generated.js";\n',
    );
    const generated = "export interface DB { sessions: { id: string } }\n";
    write(sourceRoot, ".artifacts/kysely/db.generated.ts", generated);
    write(sourceRoot, ".artifacts/kysely/inputs.sha256", "fixture-inputs\n");
    write(sourceRoot, ".artifacts/cache/unrelated.ts", "must not be staged\n");
    const helper = "export const workerHeapFlag = '--max-old-space-size=512';\n";
    const declaration = "export declare const workerHeapFlag: string;\n";
    write(sourceRoot, "worker-heap-flag.mjs", helper);
    write(sourceRoot, "worker-heap-flag.d.mts", declaration);
    const config = { entry: { agent: "src/agents/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({ ...fixtureRoot, sourceEntries, embeddedPaths: {} });
    const staged = requireFilename(graph.addEntry("dist/agent.mjs"));
    const stagedRoot = path.resolve(path.dirname(staged), "../..");
    expect(
      fs.readFileSync(path.join(stagedRoot, ".artifacts/kysely/db.generated.ts"), "utf8"),
    ).toBe(generated);
    expect(fs.readFileSync(path.join(stagedRoot, ".artifacts/kysely/inputs.sha256"), "utf8")).toBe(
      "fixture-inputs\n",
    );
    expect(fs.existsSync(path.join(stagedRoot, ".artifacts/cache"))).toBe(false);
    expect(fs.readFileSync(path.join(stagedRoot, "worker-heap-flag.mjs"), "utf8")).toBe(helper);
    expect(fs.readFileSync(path.join(stagedRoot, "worker-heap-flag.d.mts"), "utf8")).toBe(
      declaration,
    );
    expect([...graph.roots]).toEqual([staged]);
    expect([...graph.files.values()].map((file) => file.source)).toEqual([
      path.join(sourceRoot, "src/agents/index.ts"),
    ]);
  });

  it("preserves dependency declaration siblings and nearest nested dependency versions", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(sourceRoot, "src/index.ts", 'import "package-a"; import "package-b";\n');
    const packageSources = new Map<string, string>();
    const packages = [
      ["package-a", "1.0.0"],
      ["package-b", "2.0.0"],
    ] as const;
    const declaration =
      'import type { Detail } from "./detail.js";\nexport type Public = Detail;\n';
    for (const [name, version] of packages) {
      const packageRoot = path.join(sourceRoot, "node_modules", name);
      write(
        packageRoot,
        "package.json",
        JSON.stringify({ name, main: "index.js", types: "types/index.d.ts" }),
      );
      packageSources.set(
        name,
        write(packageRoot, "index.js", 'export { run } from "./lib/run.js";\n'),
      );
      write(packageRoot, "lib/run.js", "export function run() { return 42; }\n");
      write(packageRoot, "lib/data.json", '{"meaning":42}\n');
      write(packageRoot, "types/index.d.ts", declaration);
      write(packageRoot, "types/detail.d.ts", "export interface Detail { value: number }\n");
      write(
        packageRoot,
        "node_modules/nested/package.json",
        JSON.stringify({ name: "nested", version, types: "index.d.ts" }),
      );
      write(packageRoot, "node_modules/nested/index.d.ts", `export type Version = "${version}";\n`);
    }
    write(sourceRoot, "node_modules/nested/package.json", '{"name":"nested","version":"3.0.0"}\n');
    const config = { entry: { entry: "src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource: (specifier: string) => requireFilename(packageSources.get(specifier)),
    });
    const importer = requireFilename(graph.addEntry("dist/entry.mjs"));
    const staged = [];
    for (const [name, version] of packages) {
      const filename = requireFilename(graph.resolve({ path: name, importer })?.path);
      staged.push(filename);
      const packageRoot = path.dirname(filename);
      const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      const types = path.join(packageRoot, manifest.types);
      expect(fs.readFileSync(types, "utf8")).toBe(declaration);
      expect(fs.readFileSync(path.join(path.dirname(types), "detail.d.ts"), "utf8")).toBe(
        "export interface Detail { value: number }\n",
      );
      expect(fs.readFileSync(path.join(packageRoot, "lib/run.js"), "utf8")).toBe(
        "export function run() { return 42; }\n",
      );
      expect(fs.readFileSync(path.join(packageRoot, "lib/data.json"), "utf8")).toBe(
        '{"meaning":42}\n',
      );
      const resolvedNested = createRequire(filename).resolve("nested/package.json");
      expect(JSON.parse(fs.readFileSync(resolvedNested, "utf8")).version).toBe(version);
      expect(fs.realpathSync(resolvedNested)).toBe(
        path.join(sourceRoot, "node_modules", name, "node_modules/nested/package.json"),
      );
      expect(fs.lstatSync(packageRoot).isSymbolicLink()).toBe(false);
    }
    expect(staged[0]).not.toBe(staged[1]);
    expect([...graph.roots]).toEqual([importer]);
    expect(graph.files.size).toBe(3);
  });

  it("shares hoisted lookup metadata while preserving local, scoped, and root package owners", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, runtimeRoot, write } = fixtureRoot;
    write(sourceRoot, "src/index.ts", "export {};\n");
    const writePackage = (base: string, name: string, version: string) => {
      const packageRoot = path.join(base, name);
      write(packageRoot, "package.json", JSON.stringify({ name, version, main: "index.js" }));
      const filename = write(packageRoot, "index.js", `export const version = "${version}";\n`);
      return { packageRoot, filename };
    };
    const sharedRoot = path.join(sourceRoot, "node_modules/.pnpm/node_modules");
    for (const name of ["nested", "@fixture/nested"]) {
      writePackage(sharedRoot, name, "wrong-hoist");
    }
    for (let index = 0; index < 24; index += 1) {
      writePackage(sharedRoot, `hoisted-${index}`, "shared");
    }
    writePackage(sharedRoot, "@fixture/shared", "shared-scoped");
    for (const root of [sourceRoot, runtimeRoot]) {
      writePackage(path.join(root, "node_modules"), "root-only", "root");
      writePackage(path.join(root, "node_modules"), "@fixture/root-only", "root-scoped");
    }
    const packageSources = new Map<string, string>();
    for (const [index, name] of [
      "package-a",
      "@fixture/package-b",
      "package-c",
      "package-d",
    ].entries()) {
      const localRoot = path.join(
        sourceRoot,
        "node_modules/.pnpm",
        `package-${index}`,
        "node_modules",
      );
      packageSources.set(name, writePackage(localRoot, name, `local-${index}`).filename);
      writePackage(localRoot, "nested", `local-${index}`);
      writePackage(localRoot, "@fixture/nested", `scoped-${index}`);
    }
    const config = { entry: { entry: "src/index.ts" } };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource: (specifier: string) => requireFilename(packageSources.get(specifier)),
    });
    const importer = requireFilename(graph.addEntry("dist/entry.mjs"));
    const countLinks = (directory: string): number =>
      fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        if (entry.isSymbolicLink()) {
          return total + 1;
        }
        return total + (entry.isDirectory() ? countLinks(path.join(directory, entry.name)) : 0);
      }, 0);
    const contextRoot = path.dirname(path.dirname(importer));
    const before = countLinks(contextRoot);
    const versionOf = (filename: string, specifier: string) =>
      JSON.parse(
        fs.readFileSync(createRequire(filename).resolve(`${specifier}/package.json`), "utf8"),
      ).version;
    for (const [index, name] of [...packageSources.keys()].entries()) {
      const staged = requireFilename(graph.resolve({ path: name, importer })?.path);
      expect(versionOf(staged, "nested")).toBe(`local-${index}`);
      expect(versionOf(staged, "@fixture/nested")).toBe(`scoped-${index}`);
      expect(versionOf(staged, "hoisted-0")).toBe("shared");
      expect(versionOf(staged, "@fixture/shared")).toBe("shared-scoped");
      expect(versionOf(staged, "root-only")).toBe("root");
      expect(versionOf(staged, "@fixture/root-only")).toBe("root-scoped");
    }
    // Four packages should retain their small local tables, not copy 27 hoisted names each.
    expect(countLinks(contextRoot) - before).toBeLessThanOrEqual(20);

    const physical = writePackage(path.join(sourceRoot, "node_modules"), "physical", "physical");
    packageSources.set("physical", physical.filename);
    const physicalStaged = requireFilename(graph.resolve({ path: "physical", importer })?.path);
    expect(versionOf(physicalStaged, "root-only")).toBe("root");
    expect(() => createRequire(physicalStaged).resolve("hoisted-0/package.json")).toThrow();
  });

  it.each([
    "explicit",
    "dependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "optionalDependencies",
  ] as const)(
    "shares %s dependency registries across host/plugin contexts and isolates sealed bundles",
    async (declaration) => {
      const fixtureRoot = fixture();
      const { sourceRoot, runtimeRoot, write } = fixtureRoot;
      write(
        sourceRoot,
        "package.json",
        JSON.stringify({
          type: "module",
          ...(declaration === "explicit"
            ? {}
            : {
                [declaration]: { stateful: declaration === "peerDependenciesMeta" ? {} : "1.0.0" },
              }),
        }),
      );
      const registry = `const formats = new Map();
export const Format = { Set: (name, value) => formats.set(name, value), Get: name => formats.get(name) };
export const Settings = { acceleration: true };
`;
      const source = write(sourceRoot, "node_modules/stateful/index.js", registry);
      const runtime = write(runtimeRoot, "node_modules/stateful/index.js", registry);
      for (const root of [sourceRoot, runtimeRoot]) {
        write(root, "node_modules/stateful/package.json", '{"name":"stateful","type":"module"}\n');
        write(
          root,
          "node_modules/stateful/details.js",
          'export { Format, Settings } from "./index.js";\n',
        );
      }
      for (const name of ["host", "plugin", "sealed"]) {
        write(sourceRoot, `src/${name}.ts`, 'import "stateful";\n');
      }
      const host = {
        entry: { host: "src/host.ts" },
        ...(declaration === "explicit"
          ? {
              inputOptions: (options: import("tsdown").Rolldown.InputOptions) => ({
                ...options,
                external: /^stateful(?:\/|$)/u,
              }),
            }
          : {}),
      };
      const plugin = {
        entry: { plugin: "src/plugin.ts" },
        ...(declaration === "explicit" ? { deps: { neverBundle: /^stateful(?:\/|$)/u } } : {}),
      };
      const sealed = {
        entry: { sealed: "src/sealed.ts" },
        deps: { alwaysBundle: () => true },
        define: { SEALED_RUNTIME_BUILD: "true" },
      };
      const sourceEntries = createStandaloneSourceEntries({
        sourceRoot,
        configs: [host, plugin, sealed],
      });
      const graph = createStandaloneSourceGraph({
        ...fixtureRoot,
        sourceEntries,
        embeddedPaths: {},
        resolveSource: (specifier: string) =>
          specifier === "stateful" ? source : path.join(path.dirname(source), "details.js"),
      });
      const hostEntry = requireFilename(graph.addEntry("dist/host.mjs"));
      const pluginEntry = requireFilename(graph.addEntry("dist/plugin.mjs"));
      const sealedEntry = requireFilename(graph.addEntry("dist/sealed.mjs"));
      const hostDependency = requireFilename(
        graph.resolve({ path: "stateful", importer: hostEntry })?.path,
      );
      const pluginDependency = requireFilename(
        graph.resolve({ path: "stateful", importer: pluginEntry })?.path,
      );
      const sealedDependency = requireFilename(
        graph.resolve({ path: "stateful", importer: sealedEntry })?.path,
      );
      expect(hostDependency).toBe(runtime);
      expect(pluginDependency).toBe(runtime);
      expect(graph.files.has(runtime)).toBe(false);
      const hostModule = await import(pathToFileURL(hostDependency).href);
      const pluginSubpath = requireFilename(
        graph.resolve({ path: "stateful/details.js", importer: pluginEntry })?.path,
      );
      expect(pluginSubpath).toBe(path.join(path.dirname(runtime), "details.js"));
      const pluginModule = await import(pathToFileURL(pluginSubpath).href);
      const sealedModule = await import(pathToFileURL(sealedDependency).href);
      pluginModule.Format.Set("fixture", "plugin-validator");
      hostModule.Settings.acceleration = false;
      expect(hostModule.Format.Get("fixture")).toBe("plugin-validator");
      expect(pluginModule.Settings.acceleration).toBe(false);
      expect(sealedModule.Format.Get("fixture")).toBeUndefined();
      expect(sealedModule.Settings.acceleration).toBe(true);
      expect(sealedDependency).not.toBe(runtime);
      expect(graph.files.get(sealedDependency)?.context.config).toBe(sealed);
      expect(
        graph.resolveFile(source, plugin, {
          specifier: "stateful",
          importer: path.join(sourceRoot, "src/plugin.ts"),
        }),
      ).toBe(runtime);
    },
  );

  it("uses the build cwd package for dependency and published source ownership", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, runtimeRoot, write } = fixtureRoot;
    write(
      sourceRoot,
      "package.json",
      JSON.stringify({
        type: "module",
        dependencies: { "@fixture/leaf": "workspace:*", "root-only": "1" },
      }),
    );
    write(sourceRoot, "src/app.ts", 'import "@fixture/leaf";\n');
    write(
      sourceRoot,
      "packages/leaf/package.json",
      JSON.stringify({
        name: "@fixture/leaf",
        type: "module",
        exports: { ".": "./dist/index.mjs" },
        dependencies: { stateful: "1" },
        devDependencies: { "dev-only": "1" },
      }),
    );
    write(sourceRoot, "packages/leaf/nested/index.ts", 'import "stateful";\n');
    const sources = new Map<string, string>();
    for (const name of ["root-only", "stateful", "dev-only"]) {
      for (const root of [sourceRoot, runtimeRoot]) {
        const filename = write(root, `node_modules/${name}/index.js`, "export const value = 1;\n");
        write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, type: "module" }));
        if (root === sourceRoot) {
          sources.set(name, filename);
        }
      }
    }
    const app = { entry: { app: "src/app.ts" } };
    const leaf = { cwd: "packages/leaf/nested", entry: { index: "index.ts" }, outDir: "../dist" };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [app, leaf] });
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource: (specifier: string) => requireFilename(sources.get(specifier)),
    });
    const appEntry = requireFilename(graph.addEntry("dist/app.mjs"));
    const leafEntry = requireFilename(
      graph.resolve({ path: "@fixture/leaf", importer: appEntry })?.path,
    );
    expect(leafEntry).toBe(graph.addEntry("packages/leaf/dist/index.mjs"));
    expect(graph.files.get(leafEntry)?.context.config).toBe(leaf);
    expect(graph.resolve({ path: "root-only", importer: appEntry })?.path).toBe(
      path.join(runtimeRoot, "node_modules/root-only/index.js"),
    );
    expect(graph.resolve({ path: "stateful", importer: leafEntry })?.path).toBe(
      path.join(runtimeRoot, "node_modules/stateful/index.js"),
    );
    for (const name of ["root-only", "dev-only"]) {
      const filename = requireFilename(graph.resolve({ path: name, importer: leafEntry })?.path);
      expect(graph.files.get(filename)?.source).toBe(sources.get(name));
      expect(graph.files.get(filename)?.context.config).toBe(leaf);
    }
  });

  it("resolves published source owners before package lookup while preserving explicit aliases", () => {
    const fixtureRoot = fixture();
    const { sourceRoot, write } = fixtureRoot;
    write(
      sourceRoot,
      "package.json",
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk/contract": {
            types: "./dist/plugin-sdk/contract.d.ts",
            default: "./dist/plugin-sdk/contract.mjs",
          },
          "./plugin-sdk/override": "./dist/plugin-sdk/contract.mjs",
        },
      }),
    );
    const source = write(sourceRoot, "src/contract.ts", "export const owner: string = 'host';\n");
    const overridden = write(
      sourceRoot,
      "src/override.ts",
      "export const owner: string = 'override';\n",
    );
    write(sourceRoot, "src/plugin.ts", 'import "openclaw/plugin-sdk/contract";\n');
    const host = { entry: { "plugin-sdk/contract": "src/contract.ts" } };
    const plugin = {
      entry: { plugin: "src/plugin.ts" },
      deps: {
        neverBundle: /^openclaw(?:\/|$)/u,
        alwaysBundle: (id: string) => id === "openclaw/plugin-sdk/override",
      },
      alias: { "openclaw/plugin-sdk/override": overridden },
    };
    const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [host, plugin] });
    const graph = createStandaloneSourceGraph({
      ...fixtureRoot,
      sourceEntries,
      embeddedPaths: {},
      resolveSource: (specifier: string) => {
        if (specifier === overridden) {
          return overridden;
        }
        throw Object.assign(new Error(`Package lookup cannot resolve ${specifier}`), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    const pluginEntry = requireFilename(graph.addEntry("dist/plugin.mjs"));
    expect(graph.resolveOriginal("openclaw/plugin-sdk/contract", pluginEntry, plugin)).toBe(source);
    expect(graph.resolveOriginal("openclaw/plugin-sdk/override", pluginEntry, plugin)).toBe(
      overridden,
    );
    const overrideEntry = requireFilename(
      graph.resolve({ path: "openclaw/plugin-sdk/override", importer: pluginEntry })?.path,
    );
    expect(graph.files.get(overrideEntry)?.source).toBe(overridden);
    expect(graph.files.get(overrideEntry)?.context.config).toBe(plugin);
    const hostEntry = requireFilename(
      graph.resolve({ path: "openclaw/plugin-sdk/contract", importer: pluginEntry })?.path,
    );
    expect(graph.addEntry("dist/plugin-sdk/contract.mjs")).toBe(hostEntry);
    expect(graph.resolve({ path: "openclaw/plugin-sdk/contract", importer: pluginEntry })).toEqual({
      path: hostEntry,
    });
    expect(
      graph.resolveExternal(
        "openclaw/plugin-sdk/contract",
        path.join(sourceRoot, "src/plugin.ts"),
        plugin,
      ),
    ).toBe(hostEntry);
    expect(
      graph.resolveExternal("node:fs", path.join(sourceRoot, "src/plugin.ts"), plugin),
    ).toBeUndefined();
    expect(graph.files.get(hostEntry)?.context.config).toBe(host);
    expect(graph.files.get(hostEntry)?.runtimePath).toBe("dist/plugin-sdk/contract.mjs");
    expect(graph.files.get(hostEntry)?.entryRecord).toBe(
      sourceEntries.resolveImport("openclaw/plugin-sdk/contract"),
    );
    expect(graph.roots.has(hostEntry)).toBe(true);
  });
});
