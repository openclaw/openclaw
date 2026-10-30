import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { createStandaloneSourceTransforms } from "../../scripts/lib/bun-standalone-source-transforms.mjs";
import { createFsSafeWindowsHelperAssetPlugin } from "../../scripts/lib/fs-safe-windows-helper-asset.mts";
import { createPluginInventoryModuleRefsPlugin } from "../../scripts/lib/plugin-inventory-module-refs.mts";
import { createPublicSessionCardAssetsPlugin } from "../../scripts/lib/public-session-card-assets.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { typeCheckSources } from "../helpers/typescript.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const parse = createStandaloneSourceParser();

function fixture() {
  const sourceRoot = dirs.make("source-transform-");
  const runtimeRoot = dirs.make("source-transform-runtime-");
  const write = (relative: string, contents: string) => {
    const filename = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  };
  return { sourceRoot, runtimeRoot, write };
}

describe("standalone source transforms", () => {
  it("retains typed conditional arrows and their lexical bindings during analysis fallback", async () => {
    const { sourceRoot, runtimeRoot } = fixture();
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const source = `const enabled: boolean = BUILD_FLAG;
const selected = enabled ? async (BUILD_FLAG: boolean): Promise<{ BUILD_FLAG: boolean }> => ({ BUILD_FLAG }) : undefined;
`;
    const result = await adapter.transform({
      filename: path.join(sourceRoot, "conditional.ts"),
      contents: source,
      config: { define: { BUILD_FLAG: "false" } },
    });
    expect(result.contents).toBe(source.replace("= BUILD_FLAG;", "= (false);"));
    expect(() => parse(result.contents)).not.toThrow();
  });

  it("keeps build-constant comparisons type-correct without changing runtime branches", async () => {
    const { sourceRoot, runtimeRoot, write } = fixture();
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const source = `const production = "production" === process.env.NODE_ENV;
function choose(): number {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return -1;
  return 42;
}
function shadow(process: { env: { NODE_ENV: string } }): boolean {
  return process.env.NODE_ENV !== "test";
}
[production, choose(), shadow({ env: { NODE_ENV: "test" } })];`;
    const result = await adapter.transform({
      filename: path.join(sourceRoot, "main.mts"),
      contents: source,
      config: { env: { NODE_ENV: "production" } },
    });
    expect(
      typeCheckSources({
        [write("main.mts", result.contents)]: `/// <reference types="node" />\n${result.contents}`,
      }),
    ).toEqual([]);
    expect(
      vm.runInNewContext(stripTypeScriptTypes(result.contents), { process: { env: {} } }),
    ).toEqual([true, 42, false]);
    const unrelated = 'const value = "production" === "test";';
    expect(
      (await adapter.transform({ filename: "unrelated.ts", contents: unrelated, config: {} }))
        .contents,
    ).toBe(unrelated);
  });

  it("replaces config values only at unshadowed value references, retaining TypeScript and strings", async () => {
    const { sourceRoot, runtimeRoot } = fixture();
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const source = `declare const BUILD_FLAG: boolean;
const text: string = "BUILD_FLAG process.env.NODE_ENV";
const options = { BUILD_FLAG };
function shadow(BUILD_FLAG: number): number { return BUILD_FLAG; }
function local(): string { return process.env.NODE_ENV; const process = { env: { NODE_ENV: "local" } }; }
function enabled(value: number = BUILD_FLAG ? 1 : 2): boolean { return BUILD_FLAG && value > 0; }
const environment = process.env["NODE_ENV"];
type Original = typeof BUILD_FLAG;
`;
    const { contents } = await adapter.transform({
      filename: path.join(sourceRoot, "main.ts"),
      contents: source,
      config: { define: { BUILD_FLAG: "false" }, env: { NODE_ENV: "production" } },
    });
    expect(contents).toContain('const text: string = "BUILD_FLAG process.env.NODE_ENV"');
    expect(contents).toContain("const options = { BUILD_FLAG: (false) }");
    expect(contents).toContain(
      "function shadow(BUILD_FLAG: number): number { return BUILD_FLAG; }",
    );
    expect(contents).toContain(
      'return process.env.NODE_ENV; const process = { env: { NODE_ENV: "local" } }',
    );
    expect(contents).toContain("value: number = (false) ? 1 : 2");
    expect(contents).toContain("return (false) && value > 0");
    expect(contents).toContain('const environment = ("production")');
    expect(contents).toContain("type Original = typeof BUILD_FLAG;");
    expect(() => parse(contents)).not.toThrow();
    const other = await adapter.transform({
      filename: path.join(sourceRoot, "main.ts"),
      contents: source,
      config: { define: { BUILD_FLAG: "true" } },
    });
    expect(other.contents).toContain("return (true) && value > 0");
    await expect(
      adapter.transform({
        filename: path.join(sourceRoot, "write.ts"),
        contents: "BUILD_FLAG = true;",
        config: { define: { BUILD_FLAG: "false" } },
      }),
    ).rejects.toThrow("Cannot assign");
  });

  it("uses the canonical schema load hook instead of evaluating the source loader", async () => {
    const { sourceRoot, runtimeRoot, write } = fixture();
    const sql = "CREATE TABLE example (value TEXT);\n-- process.env.NODE_ENV\n";
    write("src/state/openclaw-state-schema.sql", sql);
    const filename = write(
      "src/state/openclaw-state-schema.ts",
      'throw new Error("must be replaced");',
    );
    const config = {
      plugins: [Promise.resolve([createStateSchemaInlinePlugin(sourceRoot)])],
      env: { NODE_ENV: "production" },
    };
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const transformed = await adapter.transform({
      filename,
      contents: fs.readFileSync(filename, "utf8"),
      config,
    });
    expect(transformed.contents).toBe(
      `export const OPENCLAW_STATE_SCHEMA_SQL = ${JSON.stringify(sql)};\n`,
    );
    expect(transformed.moduleType).toBe("js");
    expect(transformed.watchFiles).toContain(
      path.join(sourceRoot, "src/state/openclaw-state-schema.sql"),
    );
    expect(await adapter.load({ filename, config })).toEqual(transformed);
  });

  it("replaces runtime TypeScript expressions while preserving enum and namespace bindings", async () => {
    const { sourceRoot, runtimeRoot } = fixture();
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const result = await adapter.transform({
      filename: path.join(sourceRoot, "runtime.ts"),
      config: { define: { BUILD_FLAG: "false" }, env: { NODE_ENV: "production" } },
      contents: `enum Mode { Enabled = BUILD_FLAG ? 1 : 0 }
enum Local { BUILD_FLAG = 1, Enabled = BUILD_FLAG }
namespace Feature { export const enabled: boolean = BUILD_FLAG; }
namespace Scoped { const BUILD_FLAG = true; export const enabled = BUILD_FLAG; }
namespace Environment { export const name: string = process.env.NODE_ENV; }
class Service { constructor(public enabled: boolean = BUILD_FLAG) {} }
declare namespace Types { const BUILD_FLAG: boolean; }
const outside: boolean = BUILD_FLAG;
`,
    });
    expect(result.contents).toContain("enum Mode { Enabled = (false) ? 1 : 0 }");
    expect(result.contents).toContain("enum Local { BUILD_FLAG = 1, Enabled = BUILD_FLAG }");
    expect(result.contents).toContain(
      "namespace Feature { export const enabled: boolean = (false); }",
    );
    expect(result.contents).toContain(
      "namespace Scoped { const BUILD_FLAG = true; export const enabled = BUILD_FLAG; }",
    );
    expect(result.contents).toContain(
      'namespace Environment { export const name: string = ("production"); }',
    );
    expect(result.contents).toContain("constructor(public enabled: boolean = (false))");
    expect(result.contents).toContain("declare namespace Types { const BUILD_FLAG: boolean; }");
    expect(result.contents).toContain("const outside: boolean = (false);");
    expect(() => parse(result.contents)).not.toThrow();
  });

  it("copies canonical session assets and relocates their URLs without erasing typed source", async () => {
    const { sourceRoot, runtimeRoot, write } = fixture();
    const fonts = [
      "Lato-Regular.ttf",
      "Lato-Bold.ttf",
      "InstrumentSerif-Regular.ttf",
      "IBMPlexMono-Regular.ttf",
    ];
    const licenses = ["Lato-OFL.txt", "InstrumentSerif-OFL.txt", "IBMPlexMono-OFL.txt"];
    for (const name of [...fonts, ...licenses]) {
      write(`src/gateway/assets/session-card/${name}`, `bytes:${name}`);
    }
    const source = `const size: number = 3;\nconst fonts = [${fonts.map((name) => `new URL("./assets/session-card/${name}", import.meta.url)`).join(",")}];`;
    const filename = write("src/gateway/control-ui-public-session-card-render.ts", source);
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const result = await adapter.transform({
      filename,
      contents: source,
      config: { plugins: [createPublicSessionCardAssetsPlugin(sourceRoot)] },
    });
    expect(result.contents).toContain("const size: number = 3");
    expect(result.contents).not.toContain("ROLLUP_FILE_URL");
    expect(result.contents).toContain(
      'new URL("dist/assets/session-card/Lato-Regular.ttf", globalThis.__openclawStandaloneRootUrl).href',
    );
    for (const name of [...fonts, ...licenses]) {
      expect(
        fs.readFileSync(path.join(runtimeRoot, "dist/assets/session-card", name), "utf8"),
      ).toBe(`bytes:${name}`);
    }
    expect(result.emitted).toHaveLength(7);
  });

  it("registers inventory companions through the graph owner without adding eager imports", async () => {
    const { sourceRoot, runtimeRoot, write } = fixture();
    const root = path.join(sourceRoot, "extensions/demo");
    const target = write("extensions/demo/runtime.ts", "export const value: number = 1;");
    const filename = write("extensions/demo/setup.ts", "");
    const source = `import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelSetupEntry({ plugin: { specifier: "./runtime.js" } });`;
    const requested: unknown[] = [];
    const config = { plugins: [createPluginInventoryModuleRefsPlugin(root)] };
    const adapter = createStandaloneSourceTransforms({
      sourceRoot,
      runtimeRoot,
      parse,
      resolveModule: async () => ({ id: target }),
      emitChunk: async (chunk: unknown) => {
        requested.push(chunk);
        return { runtimePath: "dist/extensions/demo/runtime.js" };
      },
    });
    const result = await adapter.transform({ filename, contents: source, config });
    expect(requested).toEqual([
      expect.objectContaining({ type: "chunk", id: target, importer: filename, config }),
    ]);
    expect(result.contents).toContain(
      'new URL("dist/extensions/demo/runtime.js", globalThis.__openclawStandaloneRootUrl).href',
    );
    expect(result.contents).not.toContain('import "./runtime');
    expect(result.contents).not.toContain('from "./runtime');
    await expect(
      createStandaloneSourceTransforms({
        sourceRoot,
        runtimeRoot,
        parse,
        resolveModule: async () => ({ id: target }),
      }).transform({ filename, contents: source, config }),
    ).rejects.toThrow("requires an emitChunk owner");
  });

  it("stages the canonical startup helper asset once for each owning config", async () => {
    const { sourceRoot, runtimeRoot, write } = fixture();
    write("node_modules/@openclaw/fs-safe/package.json", '{"optionalDependencies":{}}');
    const filename = write(
      "node_modules/@openclaw/fs-safe/dist/native.js",
      'const manifest = require("../package.json");',
    );
    const executable = write(
      "node_modules/@openclaw/fs-safe/dist/windows-security-helper.exe",
      "synthetic helper",
    );
    const inputs: string[] = [];
    const plugin = createFsSafeWindowsHelperAssetPlugin(sourceRoot, undefined, (input) =>
      inputs.push(input),
    );
    const config = { plugins: [plugin] };
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const transform = () =>
      adapter.transform({ filename, contents: fs.readFileSync(filename, "utf8"), config });
    const [first, second] = await Promise.all([transform(), transform()]);
    expect(first.contents).toBe('const manifest = {"optionalDependencies":{}};');
    expect(second.contents).toBe(first.contents);
    expect(inputs.filter((input) => input === executable)).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(runtimeRoot, "dist/windows-security-helper.exe"), "utf8"),
    ).toBe("synthetic helper");
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toEqual(first.emitted);
  });

  it("records canonical source inputs through the known runtime inventory hook", async () => {
    const { sourceRoot, runtimeRoot } = fixture();
    const inputs = new Set<string>();
    const filename = path.join(sourceRoot, "extensions/demo/index.ts");
    const moduleParsed = ({ id }: { id: string }) => inputs.add(path.relative(sourceRoot, id));
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    await adapter.transform({
      filename,
      contents: "export const value: number = 1;",
      config: { plugins: [{ name: "openclaw:runtime-build-inputs", moduleParsed }] },
    });
    expect([...inputs]).toEqual(["extensions/demo/index.ts"]);
    await expect(
      adapter.transform({
        filename,
        contents: "",
        config: { plugins: [{ name: "unknown-inputs", moduleParsed }] },
      }),
    ).rejects.toThrow("unknown-inputs.moduleParsed");
  });

  it("supports virtual source hooks and refuses unknown lifecycle hooks", async () => {
    const { sourceRoot, runtimeRoot } = fixture();
    const adapter = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
    const config = {
      plugins: [
        {
          name: "virtual",
          resolveId(id: string) {
            return id === "optional" ? "virtual:optional" : null;
          },
          load(id: string) {
            return id === "virtual:optional" ? "export const available: boolean = false;" : null;
          },
        },
      ],
    };
    expect(await adapter.resolve({ specifier: "optional", config })).toEqual({
      id: "virtual:optional",
    });
    expect((await adapter.load({ filename: "virtual:optional", config }))?.contents).toBe(
      "export const available: boolean = false;",
    );
    await expect(
      adapter.transform({
        filename: "main.ts",
        contents: "",
        config: { plugins: [{ name: "unknown", buildStart() {} }] },
      }),
    ).rejects.toThrow("unknown.buildStart");
    const deferred = await adapter.transform({
      filename: "main.ts",
      contents: "",
      config: {
        plugins: [
          {
            name: "openclaw:worker-deploy",
            generateBundle() {
              throw new Error("not a source hook");
            },
          },
        ],
      },
    });
    expect(deferred.deferredHooks).toEqual([
      expect.objectContaining({ plugin: "openclaw:worker-deploy", hook: "generateBundle" }),
    ]);
  });
});
