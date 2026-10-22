import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

const root = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nativeName = `@esbuild/${process.platform}-${process.arch}`;
const nativeExecutable = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
const directoryLink = process.platform === "win32" ? "junction" : "dir";

function rewrite(file: string, transform: (source: string) => string) {
  fs.writeFileSync(file, transform(fs.readFileSync(file, "utf8")));
}

function fixture() {
  const home = tempDirs.make("native-protocol-tooling-");
  const result = createToolingDependencyFixture(home);
  const { directories, files } = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/native-protocol-inputs.json"), "utf8"),
  ) as { directories: string[]; files: string[] };
  for (const file of [...directories, ...files]) {
    const destination = path.join(result.checkout, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(root, file), destination, { recursive: true });
  }
  const esbuild = fs.realpathSync(path.join(root, "node_modules/esbuild"));
  const require = createRequire(path.join(esbuild, "package.json"));
  for (const [name, source] of [
    ["esbuild", esbuild],
    ["typebox", fs.realpathSync(path.join(root, "node_modules/typebox"))],
    [nativeName, path.dirname(require.resolve(`${nativeName}/package.json`))],
  ] as const) {
    fs.cpSync(source, path.join(result.tooling, "node_modules", name), { recursive: true });
  }
  for (const [workspace, packages] of [
    ["gateway-protocol", ["esbuild", "typebox"]],
    ["normalization-core", ["typebox"]],
  ] as const) {
    const owner = path.join(result.tooling, "packages", workspace);
    fs.mkdirSync(path.join(owner, "node_modules"), { recursive: true });
    for (const name of packages) {
      fs.symlinkSync(
        path.join(result.tooling, "node_modules", name),
        path.join(owner, "node_modules", name),
        directoryLink,
      );
    }
  }
  const owner = path.join(result.tooling, "packages/gateway-protocol");
  fs.mkdirSync(path.join(owner, "scripts"));
  fs.writeFileSync(
    path.join(owner, "scripts/native-codegen.ts"),
    'throw new Error("FOREIGN GENERATOR EXECUTED");',
  );
  const output = path.join(home, "output");
  const generate = (entry = path.join(result.checkout, "scripts/prepare-native-protocol.mjs")) =>
    spawnSync(process.execPath, [entry, "--check", "--language", "swift", "--out", output], {
      cwd: result.checkout,
      env: result.env,
      encoding: "utf8",
      timeout: 30_000,
    });
  delete result.env.ESBUILD_BINARY_PATH;
  return {
    ...result,
    home,
    output,
    generate,
    esbuild: path.join(result.tooling, "node_modules/esbuild"),
    typebox: path.join(result.tooling, "node_modules/typebox"),
    native: path.join(result.tooling, "node_modules", nativeName),
  };
}

it("generates deterministic contracts from current checkout source using installed donor packages only", () => {
  const current = fixture();
  rewrite(path.join(current.checkout, "packages/gateway-protocol/src/version.ts"), (source) =>
    source.replace(/PROTOCOL_VERSION = \d+/, "PROTOCOL_VERSION = 777"),
  );
  const first = current.generate();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("contract and determinism checked");
  const output = path.join(current.output, "GatewayModels.swift");
  const generated = fs.readFileSync(output, "utf8");
  expect(generated).toContain("GATEWAY_PROTOCOL_VERSION = 777");
  expect(generated).toContain("public struct RequestFrame:");
  const repeated = current.generate();
  expect(repeated.status, repeated.stderr).toBe(0);
  expect(fs.readFileSync(output, "utf8")).toBe(generated);
  expect(fs.existsSync(path.join(current.checkout, "node_modules"))).toBe(false);
});

it("rejects a cached esbuild API initialized with an unqualified binary", () => {
  const current = fixture();
  const entry = path.join(current.checkout, "scripts/cached-esbuild.mjs");
  fs.writeFileSync(
    entry,
    `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(path.join(current.esbuild, "package.json"))});
process.env.ESBUILD_BINARY_PATH = process.execPath;
require("esbuild");
delete process.env.ESBUILD_BINARY_PATH;
const { prepareNativeProtocol } = await import("./prepare-native-protocol.mjs");
await prepareNativeProtocol({ language: "swift", check: true, out: ${JSON.stringify(current.output)} });
`,
  );
  const result = current.generate(entry);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("esbuild was already loaded");
  expect(result.stderr).not.toContain("bad option: --service");
  expect(fs.existsSync(path.join(current.output, "GatewayModels.swift"))).toBe(false);
});

it.each([
  ["esbuild version", "requires 0.28.2"],
  ["workspace pin", "requires 0.0.0"],
  ["native version", "requires 0.28.2"],
  ["package escape", "escapes its installed dependency owner"],
  ["entry escape", "escapes its installed dependency owner"],
  ["native escape", "escapes its installed dependency owner"],
  ["binary override", "overridden native protocol esbuild binary"],
  ["different repository", "Different repository"],
  ["foreign dependency input", "escapes its installed dependency owner"],
  ["undeclared input", "missing from scripts/native-protocol-inputs.json"],
  ["nondeterministic output", "protocol generation is not deterministic"],
])("rejects %s without writing generated contracts", (scenario, diagnostic) => {
  const current = fixture();
  const codegen = path.join(
    current.checkout,
    "packages/gateway-protocol/scripts/native-codegen.ts",
  );
  if (scenario === "esbuild version" || scenario === "native version") {
    rewrite(
      path.join(scenario === "esbuild version" ? current.esbuild : current.native, "package.json"),
      (source) => JSON.stringify({ ...JSON.parse(source), version: "0.0.0" }),
    );
  } else if (scenario === "workspace pin") {
    rewrite(path.join(current.checkout, "packages/gateway-protocol/package.json"), (source) =>
      JSON.stringify({ ...JSON.parse(source), dependencies: { typebox: "0.0.0" } }),
    );
  } else if (scenario.endsWith("escape")) {
    const target =
      scenario === "entry escape"
        ? path.join(current.esbuild, "lib/main.js")
        : scenario === "native escape"
          ? path.join(current.native, nativeExecutable)
          : current.typebox;
    const outside = path.join(current.home, "outside");
    fs.renameSync(target, outside);
    fs.symlinkSync(outside, target, scenario === "package escape" ? directoryLink : "file");
  } else if (scenario === "binary override") {
    current.env.ESBUILD_BINARY_PATH = process.execPath;
  } else if (scenario === "different repository") {
    const result = spawnSync(
      "git",
      ["-C", current.tooling, "remote", "set-url", "origin", "https://github.com/example/other"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  } else if (scenario === "foreign dependency input") {
    const foreign = path.join(current.home, "node_modules/foreign.mjs");
    fs.mkdirSync(path.dirname(foreign));
    fs.writeFileSync(foreign, 'throw new Error("FOREIGN GENERATOR EXECUTED");');
    rewrite(codegen, (source) => `import ${JSON.stringify(foreign)};\n${source}`);
  } else if (scenario === "undeclared input") {
    fs.writeFileSync(
      path.join(current.checkout, "scripts/undeclared-native.mjs"),
      'throw new Error("UNDECLARED SOURCE EXECUTED");',
    );
    rewrite(codegen, (source) => `import "../../../scripts/undeclared-native.mjs";\n${source}`);
  } else {
    rewrite(codegen, (source) =>
      source.replace("generateSwiftProtocol()", "generateSwiftProtocol() + Math.random()"),
    );
  }
  const result = current.generate();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout + result.stderr).not.toContain("FOREIGN GENERATOR EXECUTED");
  expect(result.stderr).not.toContain("Error: UNDECLARED SOURCE EXECUTED");
  expect(fs.existsSync(path.join(current.output, "GatewayModels.swift"))).toBe(false);
  expect(fs.existsSync(path.join(current.checkout, "node_modules"))).toBe(false);
});
