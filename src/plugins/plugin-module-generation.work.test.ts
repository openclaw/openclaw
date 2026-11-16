import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { useNodeModuleHooks } from "./native-module-require.js";
import { capturePluginGenerationArtifactInScope } from "./plugin-generation-capture.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";
import { buildPluginTypeScriptSource } from "./plugin-source-build.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

describe.skipIf(!useNodeModuleHooks())("plugin generation demanded work", () => {
  it("keeps resolve-only paths stable without materializing compiler outputs", async () => {
    const root = fixture({
      "entry.ts":
        "export const resolve = () => require.resolve('./deferred.ts'); export const read = () => import('./deferred.ts');",
      "deferred.ts": "export const value = 42;",
      "unused.ts": "export const unused = 1;",
    });
    using guard = observeMainThreadFs();
    const plugin = host(root).load("entry.ts") as {
      resolve(): string;
      read(): Promise<{ value: number }>;
    };
    const resolved = plugin.resolve();
    expect(fs.readFileSync(resolved, "utf8")).toBe("");
    expect(plugin.resolve()).toBe(resolved);
    await expect(plugin.read()).resolves.toMatchObject({ value: 42 });
    expect(plugin.resolve()).toBe(resolved);
    expect(
      guard
        .stacks()
        .filter(
          ({ api, opensForWrite, stack }) =>
            stack.includes("plugin-source-build") &&
            (opensForWrite ||
              /^(?:mkdtemp|mkdir|writeFile|rename|unlink|rm|copyFile|symlink|link)Sync$/.test(api)),
        ),
    ).toEqual([]);
  });

  it("compiles retained source text without reopening or writing compiler files", async () => {
    const root = fixture({ "entry.mts": "export const value: number = 42;" });
    const source = path.join(root, "entry.mts");
    const artifact = capturePluginGenerationArtifactInScope(root, source);
    const captured = artifact.resolve(source);
    const build = buildPluginTypeScriptSource(
      artifact.rootDir,
      artifact.executionAlias,
      artifact.sourceText,
    );
    try {
      // Successful execution after unlink proves source bytes are not reopened.
      // Compiler dependencies may still perform their own ordinary module reads.
      fs.unlinkSync(captured);
      using guard = observeMainThreadFs();
      const output = build.resolve(captured, "native", "module");
      expect(createRequire(import.meta.url)(output).value).toBe(42);
      build.dispose();
      expect(
        guard
          .stacks()
          .filter(
            ({ api, opensForWrite, stack }) =>
              stack.includes("plugin-source-build") &&
              (opensForWrite ||
                /^(?:mkdtemp|mkdir|writeFile|rename|unlink|rm|copyFile|symlink|link)Sync$/.test(
                  api,
                )),
          ),
      ).toEqual([]);
    } finally {
      build.dispose();
      await artifact.disposeAsync();
    }
  });

  it("compiles sync and async TypeScript with only the selected Jiti transformer", async () => {
    const root = fixture({
      "entry.ts":
        "import type { require } from 'missing-type-only-package'; function shadow(require: (value: string) => string) { return require('label'); } export const shadowed = shadow(value => value); export const read = () => import('./deferred.ts'); export const required = require('node:path').sep;",
      "deferred.ts":
        "enum __filename { Answer = 42 }; namespace __dirname { export const answer = 1 }; export const value = __filename.Answer + __dirname.answer;",
    });
    // oxlint-disable-next-line typescript/unbound-method -- retain the intercepted receiver below.
    const originalRequire = Module.prototype.require;
    const guard = vi.spyOn(Module.prototype, "require").mockImplementation(function (
      this: NodeJS.Module,
      id: string,
    ) {
      if (id === "esbuild") {
        throw new Error("Jiti compilation must not acquire a second TypeScript transformer");
      }
      return originalRequire.call(this, id);
    });
    try {
      const plugin = host(root).load("entry.ts") as {
        required: string;
        shadowed: string;
        read(): Promise<{ value: number }>;
      };
      expect(plugin.required).toBe(path.sep);
      expect(plugin.shadowed).toBe("label");
      await expect(plugin.read()).resolves.toMatchObject({ value: 43 });
    } finally {
      guard.mockRestore();
    }
  });

  it("reuses captured package metadata while new local demands still resolve dependencies", () => {
    const root = fixture({
      "package.json": '{"dependencies":{"dependency":"1"},"optionalDependencies":{"absent":"1"}}',
      "entry.cjs": "exports.directory = __dirname; exports.read = name => require(name).value;",
      "first.cjs": "exports.value = require('dependency').value;",
      "second.cjs": "exports.value = require('dependency').value + 1;",
      "node_modules/dependency/package.json": '{"main":"index.cjs"}',
      "node_modules/dependency/index.cjs": "exports.value = 41;",
    });
    const plugin = host(root).load("entry.cjs") as {
      directory: string;
      read(name: string): number;
    };
    const read = vi.spyOn(fs, "readFileSync");
    try {
      expect(plugin.read("./first.cjs")).toBe(41);
      expect(plugin.read("./second.cjs")).toBe(42);
      expect(
        read.mock.calls.filter(
          ([filename]) => filename === path.join(plugin.directory, "package.json"),
        ),
      ).toHaveLength(0);
    } finally {
      read.mockRestore();
    }
  });
});
