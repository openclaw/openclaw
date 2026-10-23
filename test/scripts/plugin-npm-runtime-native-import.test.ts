import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cli = path.resolve(import.meta.dirname, "../../scripts/lib/plugin-npm-runtime-build.mjs");

function writeFile(root: string, relative: string, content: string | Record<string, unknown>) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
}

function fixture(format = "esm", declaration = "peerDependencies") {
  const root = tempDirs.make("openclaw-native-import-");
  const write = (relative: string, content: string) => writeFile(root, relative, content);
  fs.mkdirSync(path.join(root, "src"));
  write("pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
  // Setup runs source tooling with workspace aliases; native children below do not load tsx.
  writeFile(root, "tsconfig.json", {
    extends: path.resolve(import.meta.dirname, "../../tsconfig.json"),
  });
  write("tsconfig.native.json", "{}\n");
  // The supported host predates the private FFmpeg and playback facades.
  const sdk = {
    "text-utility-runtime": "export {};\n",
    "media-runtime": 'export function resolveFfmpegBin() { return "host"; }\n',
    "realtime-voice-provider": 'export const canonicalizeBase64 = () => "provider";\n',
    "realtime-voice":
      'export const createRealtimeVoiceOutputActivityTracker = () => "voice"; export const isRealtimeVoiceAudioAudible = () => "audible";\n',
  };
  writeFile(root, "package.json", {
    name: "openclaw",
    version: "2026.9.5",
    type: "module",
    exports: Object.fromEntries(
      Object.keys(sdk).map((name) => [`./plugin-sdk/${name}`, `./dist/plugin-sdk/${name}.js`]),
    ),
  });
  for (const [name, content] of Object.entries(sdk)) {
    write(`dist/plugin-sdk/${name}.js`, content);
  }
  for (const module of ["grapheme", "utf16-slice"]) {
    const relative = `packages/normalization-core/src/${module}.ts`;
    write(relative, fs.readFileSync(path.resolve(import.meta.dirname, "../..", relative), "utf8"));
  }
  write("node_modules/fixture-dep/package.json", '{"name":"fixture-dep","main":"index.cjs"}');
  write("node_modules/fixture-dep/index.cjs", 'exports.thirdParty = "third-party";\n');
  const packageDir = path.join(root, "extensions/demo");
  writeFile(packageDir, "package.json", {
    name: "@openclaw/demo",
    version: "1.0.0",
    type: "module",
    optionalDependencies: { "fixture-dep": "1.0.0" },
    [declaration]: {
      ...(declaration === "optionalDependencies" ? { "fixture-dep": "1.0.0" } : {}),
      openclaw: "*",
    },
    openclaw: {
      extensions: ["./index.ts"],
      build: { runtimeFormat: format },
      release: { publishToNpm: true },
    },
  });
  writeFile(
    packageDir,
    "index.ts",
    `import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-ffmpeg";
import { createRealtimeVoiceOutputActivityTracker, isRealtimeVoiceAudioAudible } from "openclaw/plugin-sdk/realtime-voice-playback";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/realtime-voice-provider";
import { findGraphemeChunkEnd } from "openclaw/plugin-sdk/text-grapheme";
import { thirdParty } from "fixture-dep";
import { writeFileSync } from "node:fs";
writeFileSync("executed", "yes");
export const answer = \`\${resolveFfmpegBin()} \${thirdParty} \${createRealtimeVoiceOutputActivityTracker()} \${isRealtimeVoiceAudioAudible()} \${canonicalizeBase64()} \${findGraphemeChunkEnd('xa\\u0301z', 0, 2)}\`;`,
  );
  const entry = `./extensions/demo/dist/index.${format === "cjs" ? "cjs" : "js"}`;
  write(entry, 'throw new Error("Preparation must not execute plugin code");\n');
  return { root, packageDir, entry };
}

function runCli(root: string, args: string[], status = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(status);
  return result;
}

function nativeImport(root: string, entry: string, format: string) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const flags = process.versions.bun
    ? ["--no-install", "--tsconfig-override", path.join(root, "tsconfig.native.json")]
    : [];
  const code =
    format === "cjs"
      ? `import { createRequire } from "node:module"; console.log(createRequire(import.meta.url)(${JSON.stringify(entry)}).answer);`
      : `console.log((await import(${JSON.stringify(entry)})).answer);`;
  return spawnSync(process.execPath, [...flags, "--input-type=module", "-e", code], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function snapshot(root: string, directories: string[]) {
  const entries: Record<string, { mtime: bigint; hash: string | null }> = {};
  for (const directory of directories) {
    for (const name of ["", ...fs.readdirSync(path.join(root, directory), { recursive: true })]) {
      const relative = path.join(directory, String(name));
      const target = path.join(root, relative);
      const stat = fs.statSync(target, { bigint: true });
      const content = stat.isFile() ? fs.readFileSync(target) : null;
      const hash = content ? createHash("sha256").update(content).digest("hex") : null;
      entries[relative] = { mtime: stat.mtimeNs, hash };
    }
  }
  return entries;
}

function rejectionFixture() {
  const { root } = fixture();
  const outside = tempDirs.make("openclaw-native-import-outside-");
  writeFile(outside, "marker", "keep");
  return {
    root,
    outside,
    write: (file: string, content: string) => writeFile(root, file, content),
    remove: (file: string) => fs.rmSync(path.join(root, file), { recursive: true }),
    link: (file: string) => fs.symlinkSync(outside, path.join(root, file), "junction"),
    moveLink(file: string) {
      const target = path.join(outside, path.basename(file));
      fs.renameSync(path.join(root, file), target);
      fs.symlinkSync(target, path.join(root, file), file.endsWith(".json") ? "file" : "junction");
    },
  };
}

type Mutation = (fixture: ReturnType<typeof rejectionFixture>) => string | void;
type RejectionCase = [string, Mutation, RegExp];
const packageError = /real immediate extensions/u;
const manifestError = /safely read.*package.json/u;
const sourceError = /source checkout root/u;
const outputError = /run node scripts\/lib\/plugin-npm-runtime-build.mjs/u;
const directoryError = /not a real directory/u;

it.each([
  [false, ["--prepare-native-import", "extensions/demo", ""]],
  [false, ["extensions/demo", "", "--prepare-native-import"]],
  [false, ["extensions/demo", "", "--prepare-native-import", "--unexpected"]],
  [true, ["", "--unexpected"]],
] satisfies [boolean, string[]][])("rejects excess argv: JS=%s %j", (jsOnly, argv) => {
  const { root, packageDir } = fixture();
  const jsDir = path.join(root, "javascript-only");
  if (jsOnly) {
    writeFile(jsDir, "package.json", {
      name: "@openclaw/arity-js-fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    });
    writeFile(jsDir, "index.js", 'throw new Error("JS-only argv proof must not execute");\n');
    writeFile(jsDir, "dist/sentinel.js", "keep\n");
  }
  const before = snapshot(root, ["."]);
  if (jsOnly) {
    runCli(root, [jsDir]);
    expect(snapshot(root, ["."])).toEqual(before);
  }
  const result = runCli(root, jsOnly ? [jsDir, ...argv] : argv, 1);
  expect(result.stderr).toContain("unexpected plugin npm runtime build argument");
  expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);
  expect(fs.existsSync(path.join(root, "executed"))).toBe(false);
  expect(snapshot(root, ["."])).toEqual(before);
});

it.each([
  ["esm", "peerDependencies"],
  ["cjs", "dependencies"],
  ["esm", "optionalDependencies"],
  ["cjs", "optionalDependencies"],
])("prepares %s output with a missing %s host link without rebuilding", (format, declaration) => {
  const { root, packageDir, entry } = fixture(format, declaration);
  runCli(root, ["extensions/demo"]);
  expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);
  const missing = nativeImport(root, entry, format);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toMatch(/Cannot find (?:package|module) 'openclaw/u);

  writeFile(packageDir, "node_modules/keep/marker", "unrelated local contents");
  const directories = [
    "dist",
    "extensions/demo/dist",
    "node_modules",
    "extensions/demo/node_modules/keep",
  ];
  const before = snapshot(root, directories);
  runCli(root, ["--prepare-native-import", "extensions/demo"]);
  expect(fs.existsSync(path.join(root, "executed"))).toBe(false);
  const link = path.join(packageDir, "node_modules/openclaw");
  expect(fs.realpathSync(link)).toBe(root);
  const linkBefore = fs.lstatSync(link, { bigint: true });
  runCli(root, ["extensions/demo", "--prepare-native-import"]);
  expect(fs.lstatSync(link, { bigint: true }).mtimeNs).toBe(linkBefore.mtimeNs);
  expect(snapshot(root, directories)).toEqual(before);

  const loaded = nativeImport(root, entry, format);
  expect(loaded.status, loaded.stderr).toBe(0);
  expect(loaded.stdout.trim()).toBe("host third-party voice audible provider 1");
  expect(fs.readFileSync(path.join(root, "executed"), "utf8")).toBe("yes");
  expect(snapshot(root, directories)).toEqual(before);
});

it("does not infer a host declaration from devDependencies or publication metadata", () => {
  const { root, packageDir } = fixture("esm", "devDependencies");
  const result = runCli(root, ["--prepare-native-import", "extensions/demo"], 1);
  expect(result.stderr).toMatch(/does not declare openclaw/u);
  expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);
});

it.each([
  ["outside package", (f) => f.outside, packageError],
  ["nested package", () => "extensions/demo/nested", packageError],
  ["symlinked package", (f) => f.moveLink("extensions/demo"), packageError],
  ["symlinked extensions", (f) => f.moveLink("extensions"), packageError],
  ["symlinked manifest", (f) => f.moveLink("extensions/demo/package.json"), manifestError],
  ["invalid manifest", (f) => f.write("extensions/demo/package.json", "[]"), manifestError],
  ["wrong host", (f) => f.write("package.json", '{"name":"unrelated"}'), sourceError],
  ["not source", (f) => f.remove("src"), sourceError],
  ["missing host output", (f) => f.remove("dist"), /Host SDK output is missing/u],
  ["missing plugin output", (f) => f.remove("extensions/demo/dist"), outputError],
  ["symlinked node_modules", (f) => f.link("extensions/demo/node_modules"), directoryError],
  [
    "unrelated host directory",
    (f) => {
      f.write("extensions/demo/node_modules/openclaw/package.json", '{"name":"unrelated"}');
      f.write("extensions/demo/node_modules/openclaw/marker", "keep");
    },
    /already exists and is not a symlink/u,
  ],
] satisfies RejectionCase[])("rejects %s without mutation", (_scenario, mutate, expected) => {
  const f = rejectionFixture();
  const selected = mutate(f) ?? "extensions/demo";
  const { root, outside } = f;
  const before = snapshot(root, ["."]);
  const outsideBefore = snapshot(outside, ["."]);
  const result = runCli(root, ["--prepare-native-import", selected], 1);
  expect(result.stderr).toMatch(expected);
  expect(snapshot(root, ["."])).toEqual(before);
  expect(snapshot(outside, ["."])).toEqual(outsideBefore);
});
