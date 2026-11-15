import fs from "node:fs";
import path from "node:path";
import type { UserConfig } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";
import {
  cacheTsdownRuntimeConfigs,
  finalizeTsdownRuntimeCaches,
  TSDOWN_CACHE_PENDING_ENV,
} from "../../scripts/lib/tsdown-runtime-cache.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("reuses packages across QA modes while rebuilding changed inputs, corrupt outputs, and copied assets", async () => {
  let root = createTempDir("tsdown-runtime-cache-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  vi.spyOn(process, "cwd").mockImplementation(() => root);
  vi.stubEnv("OPENCLAW_RUN_NODE_SKIP_DTS_BUILD", "1");
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "0");
  const cache = createTempDir("tsdown-runtime-cache-store-");
  vi.stubEnv("BUILD_ALL_CACHE_ROOT", cache);
  const names = ["a", "b", "copied"];
  const copySource = () => path.join(root, "LICENSE");
  const copiedOutput = () => path.join(root, "packages/copied/dist/LICENSE");
  const configurations = (): UserConfig[] =>
    names.map((name) => ({
      dts: false,
      name: "packages",
      entry: { index: path.join(root, `packages/${name}/src/index.ts`) },
      outDir: `packages/${name}/dist`,
      copy: name === "copied" ? [{ from: copySource(), rename: "LICENSE" }] : undefined,
    }));
  const source = (name: string) => path.join(root, `packages/${name}/src/index.ts`);
  const output = (name: string) => path.join(root, `packages/${name}/dist/index.js`);
  const dependency = () => path.join(root, "shared.ts");
  fs.writeFileSync(dependency(), "original shared input");
  fs.writeFileSync(copySource(), "original license");
  for (const name of names) {
    fs.mkdirSync(path.dirname(source(name)), { recursive: true });
    fs.writeFileSync(source(name), `export const value = "${name}-original";`);
  }
  const select = () => {
    fs.mkdirSync(path.join(root, ".artifacts"), { recursive: true });
    const pending = fs.mkdtempSync(path.join(root, ".artifacts/pending-"));
    vi.stubEnv(TSDOWN_CACHE_PENDING_ENV, pending);
    return { pending, configs: cacheTsdownRuntimeConfigs(configurations()) };
  };
  // A small compiler-host fixture supplies watch membership, writes the output,
  // and signals success through the same plugin/hooks contract as tsdown.
  const complete = async (configs: UserConfig[]) => {
    for (const config of configs) {
      const name = path.basename(path.dirname(config.outDir!));
      const watched = [source(name), ...(name === "a" ? [dependency()] : [])];
      type DoneContext = {
        chunks: { outDir: string; fileName: string }[];
        options: { configDeps: Set<string> };
      };
      const done: ((context: DoneContext) => void)[] = [];
      if (typeof config.hooks === "function") {
        await Reflect.apply(config.hooks, undefined, [
          {
            hook(event: string, callback: (context: DoneContext) => void) {
              if (event === "build:done") {
                done.push(callback);
              }
            },
          },
        ]);
      }
      const plugins = Array.isArray(config.plugins) ? config.plugins.flat() : [config.plugins];
      for (const plugin of plugins) {
        if (
          plugin &&
          typeof plugin === "object" &&
          "buildEnd" in plugin &&
          typeof plugin.buildEnd === "function"
        ) {
          Reflect.apply(plugin.buildEnd, { getModuleIds: () => watched.values() }, [undefined]);
        }
      }
      fs.mkdirSync(path.dirname(output(name)), { recursive: true });
      fs.writeFileSync(
        output(name),
        watched.map((file) => fs.readFileSync(file, "utf8")).join("\n"),
      );
      // tsdown copies assets after bundling without adding them to its chunk inventory.
      if (name === "copied") {
        fs.copyFileSync(copySource(), copiedOutput());
      }
      done.forEach((callback) =>
        callback({
          chunks: [{ outDir: path.dirname(output(name)), fileName: "index.js" }],
          options: { configDeps: new Set([path.join(root, "package.json")]) },
        }),
      );
    }
  };
  const first = select();
  fs.mkdirSync(path.join(root, "dist"));
  await complete(first.configs);
  finalizeTsdownRuntimeCaches(first.pending, root);
  const originalB = fs.readFileSync(output("b"), "utf8");
  for (const name of names) {
    fs.rmSync(path.dirname(output(name)), { recursive: true });
  }
  fs.rmSync(path.join(root, "dist"), { recursive: true });
  const previousRoot = root;
  root = createTempDir("tsdown-runtime-cache-next-release-");
  fs.cpSync(previousRoot, root, { recursive: true });
  fs.writeFileSync(path.join(root, "shared.ts"), "changed shared input");
  fs.writeFileSync(copySource(), "changed license");
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
  const second = select();
  expect(second.configs.map((config) => config.outDir)).toEqual([
    "packages/a/dist",
    "packages/copied/dist",
  ]);
  expect(fs.readFileSync(output("b"), "utf8")).toBe(originalB);
  await complete(second.configs);
  finalizeTsdownRuntimeCaches(second.pending, root);
  expect(fs.readFileSync(output("a"), "utf8")).toContain("changed shared input");
  expect(fs.readFileSync(copiedOutput(), "utf8")).toBe("changed license");
  const cachedB = path.join(cache, "tsdown-runtime-b/outputs/packages/b/dist/index.js");
  fs.writeFileSync(cachedB, "corrupt");
  fs.rmSync(path.join(root, "packages/b/dist"), { recursive: true });
  const third = select();
  expect(third.configs.map((config) => config.outDir)).toEqual([
    "packages/b/dist",
    "packages/copied/dist",
  ]);
  expect(fs.existsSync(output("b"))).toBe(false);
});

it("leaves direct builds and declaration configurations with the compiler", () => {
  const config: UserConfig = { entry: { index: "index.ts" }, dts: false };
  expect(cacheTsdownRuntimeConfigs([config])).toEqual([config]);
  vi.stubEnv(TSDOWN_CACHE_PENDING_ENV, "unused");
  vi.stubEnv("OPENCLAW_RUN_NODE_SKIP_DTS_BUILD", "1");
  const declaration = { ...config, dts: true };
  expect(cacheTsdownRuntimeConfigs([declaration])).toEqual([declaration]);
});
