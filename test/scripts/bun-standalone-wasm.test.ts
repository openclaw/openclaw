import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { planStandaloneRuntime } from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { standaloneModuleGraphSha256 } from "../../scripts/lib/bun-standalone-support.mjs";
import {
  prepareStandaloneWasm,
  standaloneWasmImport,
} from "../../scripts/lib/bun-standalone-wasm.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// () -> i32, exported as "add", returning 42.
const moduleBytes = Buffer.from(
  "0061736d010000000105016000017f030201000707010361646400000a06010400412a0b",
  "hex",
);
const decoder =
  "function binaryDecode(bin){for(var i=0,l=bin.length,o=new Uint8Array(l),c;i<l;++i){c=bin.charCodeAt(i);o[i]=~c>>8&c}return o}";

function fixture() {
  const root = tempDirs.make("standalone-wasm-");
  const runtime = path.join(root, "runtime");
  const outputRoot = path.join(root, "modules");
  fs.mkdirSync(runtime);
  function write(name: string, contents: string | Uint8Array) {
    const filename = path.join(runtime, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  }
  return { root, runtime, outputRoot, write };
}

function importedModules(registrationPath: string) {
  const ast = parse(fs.readFileSync(registrationPath, "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  return ast.body.flatMap((statement) =>
    statement.type === "ImportDeclaration" && typeof statement.source.value === "string"
      ? [path.resolve(path.dirname(registrationPath), statement.source.value)]
      : [],
  );
}

describe("standalone WebAssembly registration", () => {
  it("changes the module graph fingerprint when registered WASM bytes change", () => {
    const { outputRoot, write } = fixture();
    const source = write("dist/quickjs.wasm", moduleBytes);
    const resources = [{ source, destination: "dist/quickjs.wasm" }];
    const entry = path.join(outputRoot, "entry.js");
    const fingerprint = () => {
      const { registrationPath } = prepareStandaloneWasm({ resources, outputRoot, parse });
      if (!registrationPath) {
        throw new Error("missing WASM registration");
      }
      fs.writeFileSync(entry, standaloneWasmImport(entry, registrationPath));
      return standaloneModuleGraphSha256(outputRoot, [entry]);
    };
    const before = fingerprint();
    const changedBytes = Buffer.from(moduleBytes);
    changedBytes[changedBytes.length - 2] = 43;
    fs.writeFileSync(source, changedBytes);
    expect(fingerprint()).not.toBe(before);
  });

  it("keeps the registered graph identical across independent build roots", () => {
    const copies = [fixture(), fixture()].map(({ outputRoot, write }) => {
      const source = write("dist/quickjs.wasm", moduleBytes);
      const { registrationPath } = prepareStandaloneWasm({
        resources: [{ source, destination: "dist/quickjs.wasm" }],
        outputRoot,
        parse,
      });
      if (!registrationPath) {
        throw new Error("missing WASM registration");
      }
      const entry = path.join(outputRoot, "nested/entry.js");
      fs.mkdirSync(path.dirname(entry));
      fs.writeFileSync(entry, standaloneWasmImport(entry, registrationPath));
      return {
        hash: standaloneModuleGraphSha256(outputRoot, [entry]),
        source: fs.readFileSync(entry, "utf8"),
      };
    });
    expect(copies[0]?.source).toMatch(/^import "\.\.\/standalone-wasm-/);
    expect(copies[1]).toEqual(copies[0]);
  });

  it("imports the retained engine and .so extension once by exact byte identity", async () => {
    const { runtime, outputRoot, write } = fixture();
    write("dist/extensions/code-mode-quickjs/assets/quickjs.wasm", moduleBytes);
    write("dist/extensions/code-mode-quickjs/assets/encoding.so", moduleBytes);
    write("dist/control-ui/browser.wasm", Buffer.from("browser-owned"));
    write("node_modules/omitted/photon_rs_bg.wasm", moduleBytes);
    const resources = planStandaloneRuntime(runtime).files;
    const result = prepareStandaloneWasm({ resources, outputRoot, parse });
    expect(result.assets).toEqual([
      {
        source: "dist/extensions/code-mode-quickjs/assets/encoding.so",
        sha256: createHash("sha256").update(moduleBytes).digest("hex"),
        sizeBytes: moduleBytes.length,
      },
      {
        source: "dist/extensions/code-mode-quickjs/assets/quickjs.wasm",
        sha256: createHash("sha256").update(moduleBytes).digest("hex"),
        sizeBytes: moduleBytes.length,
      },
    ]);
    expect(result.registrationPath).toBeDefined();
    if (!result.registrationPath) {
      throw new Error("missing WASM registration");
    }
    const imports = importedModules(result.registrationPath);
    expect(imports).toHaveLength(1);
    const [filename] = imports;
    if (!filename) {
      throw new Error("missing WASM import");
    }
    expect(path.extname(filename)).toBe(".wasm");
    expect(fs.readFileSync(filename)).toEqual(moduleBytes);
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(filename));
    const add = instance.exports.add;
    if (typeof add !== "function") {
      throw new Error("missing WASM fixture export");
    }
    expect(add()).toBe(42);
  });

  it("registers inline Opus through the retained native resource plan without evaluating it", () => {
    const { runtime, outputRoot, write } = fixture();
    write(
      "package.json",
      JSON.stringify({ name: "fixture", dependencies: { "libopus-wasm": "0.4.1" } }),
    );
    write(
      "node_modules/libopus-wasm/package.json",
      JSON.stringify({
        name: "libopus-wasm",
        version: "0.4.1",
        type: "module",
        main: "dist/index.js",
      }),
    );
    write("node_modules/libopus-wasm/dist/index.js", 'import "./generated/libopus.generated.mjs";');
    const generated = write(
      "node_modules/libopus-wasm/dist/generated/libopus.generated.mjs",
      `throw new Error("must never execute");\n${decoder}\nfunction findWasmBinary(){return binaryDecode(${JSON.stringify(moduleBytes.toString("latin1"))})}`,
    );
    const native = createStandaloneNativeAdapter({ runtimeRoot: runtime, parse });
    const finalized = native.finalize({ metafile: { inputs: { [generated]: {} } } });
    const resources = planStandaloneRuntime(runtime, finalized.files).files;
    const result = prepareStandaloneWasm({ resources, outputRoot, parse });
    expect(result.assets).toMatchObject([
      {
        source: "native/libopus-wasm@0.4.1/libopus-wasm/dist/generated/libopus.generated.mjs",
        sizeBytes: moduleBytes.length,
      },
    ]);
    if (!result.registrationPath) {
      throw new Error("missing Opus registration");
    }
    const [filename] = importedModules(result.registrationPath);
    if (!filename) {
      throw new Error("missing Opus import");
    }
    expect(fs.readFileSync(filename)).toEqual(moduleBytes);
  });

  it("rejects a changed Opus decoder and corrupt curated WASM before compilation", () => {
    const { outputRoot, write } = fixture();
    const manifest = write(
      "node_modules/libopus-wasm/package.json",
      JSON.stringify({ name: "libopus-wasm" }),
    );
    write(
      "node_modules/libopus-wasm/dist/generated/libopus.generated.mjs",
      `function binaryDecode(bin){return new Uint8Array()};function findWasmBinary(){return binaryDecode(${JSON.stringify(moduleBytes.toString("latin1"))})}`,
    );
    expect(() =>
      prepareStandaloneWasm({
        resources: [{ source: manifest, destination: "native/libopus-wasm/package.json" }],
        outputRoot,
        parse,
      }),
    ).toThrow("Unsupported libopus-wasm inline payload");
    const wasm = write("dist/archive-parser.wasm", "not WASM");
    expect(() =>
      prepareStandaloneWasm({
        resources: [{ source: wasm, destination: "dist/archive-parser.wasm" }],
        outputRoot,
        parse,
      }),
    ).toThrow("Invalid standalone WASM resource: dist/archive-parser.wasm");
    expect(prepareStandaloneWasm({ resources: [], outputRoot, parse })).toEqual({
      assets: [],
      registrationPath: undefined,
    });
    expect(fs.existsSync(outputRoot)).toBe(false);
  });
});
