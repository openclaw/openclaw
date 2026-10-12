import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";

const require = createRequire(import.meta.url);
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const nativeExecutable = process.platform === "win32" ? "tsc.exe" : "tsc";

function resolvePlatformPackageDir() {
  // The platform binary belongs to the native compiler's optional dependencies.
  const nativeRequire = createRequire(require.resolve("typescript/package.json"));
  return path.dirname(nativeRequire.resolve(`${platformPackage}/package.json`));
}

/** The installed binary, for fixtures that intercept compiler launches themselves. */
export function resolveInstalledNativeCompiler() {
  return path.join(resolvePlatformPackageDir(), "lib", nativeExecutable);
}

/** Availability only; integration assertions still verify the actual kernel scope. */
export function hasSemanticTestBackend(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    return (
      fs
        .readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8")
        .split(/\s+/u)
        .includes("memory") &&
      spawnSync("systemctl", ["--user", "show", "--property=Version"], { timeout: 5_000 })
        .status === 0
    );
  } catch {
    return false;
  }
}

/**
 * Native receipts and default libraries must belong to the fixture's own install.
 * Fixtures that only launch the compiler can omit its JavaScript API (`dist/`,
 * `vendor/`); toolchain identity and fixture-resolved API imports need it.
 */
export function materializeNativeCompiler(rootDir: string, { javaScriptApi = true } = {}) {
  const root = fs.realpathSync.native(rootDir);
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  if (fs.realpathSync.native(modules) !== modules) {
    throw new Error("Native compiler fixtures need their own node_modules directory");
  }
  // Shared declaration fixtures start with tool links. Detach those fixture-owned
  // links before copying so no write can follow them back into the real install.
  for (const name of [".bin", "@typescript", "typescript", platformPackage]) {
    const target = path.join(root, "node_modules", name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(target);
    }
  }
  for (const [name, source] of [
    ["typescript", path.dirname(require.resolve("typescript/package.json"))],
    [platformPackage, resolvePlatformPackageDir()],
  ] as const) {
    const omitted =
      name === "typescript" && !javaScriptApi
        ? [path.join(source, "dist"), path.join(source, "vendor")]
        : [];
    const destination = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyTreeCloseOnExec(source, destination, {
      dereference: true,
      filter: (file) => !omitted.includes(file),
    });
  }
  const bin = path.join(root, "node_modules/.bin/tsgo");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync("../typescript/bin/tsc", bin, "file");
  if (process.platform === "win32") {
    fs.writeFileSync(`${bin}.cmd`, '@node "%~dp0..\\typescript\\bin\\tsc" %*\r\n');
  }
  return path.join(root, "node_modules", platformPackage, "lib", nativeExecutable);
}

/** Intercept a fixture compiler process without changing the production resolver. */
export function overrideNativeFixtureExecutable(root: string, executable: string) {
  const nativeRoot = path.join(root, "node_modules/typescript");
  fs.mkdirSync(path.join(nativeRoot, "lib"), { recursive: true });
  if (!fs.existsSync(path.join(nativeRoot, "package.json"))) {
    fs.writeFileSync(path.join(nativeRoot, "package.json"), '{"type":"module"}\n');
  }
  const launcher = process.platform === "win32" ? `${executable}.cmd` : executable;
  fs.writeFileSync(
    path.join(nativeRoot, "lib/getExePath.js"),
    `export default function getExePath() { return ${JSON.stringify(launcher)}; }\n`,
  );
}

export function resolveNativeFixtureShortPath(directory: string) {
  const short = spawnSync(
    "cmd.exe",
    ["/d", "/c", 'for %I in ("%DECLARATION_ALIAS_ROOT%") do @echo %~sI'],
    {
      encoding: "utf8",
      // cmd.exe owns these quotes; libuv must not backslash-escape them.
      windowsVerbatimArguments: true,
      env: { ...process.env, DECLARATION_ALIAS_ROOT: directory },
    },
  );
  if (short.error) {
    throw short.error;
  }
  if (short.status !== 0) {
    throw new Error(`Windows short-path lookup failed: ${short.stderr}`);
  }
  const target = short.stdout.trim();
  const canonical = fs.realpathSync.native(directory);
  if (fs.realpathSync.native(target) !== canonical) {
    throw new Error(`Windows short path does not resolve to its fixture directory: ${target}`);
  }
  return fs.realpathSync(target).toLowerCase() === canonical.toLowerCase() ? undefined : target;
}

export function writeNativeFixtureFile(root: string, file: string, text: string) {
  const target = path.resolve(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

/** Conflicting ancestor and importer-local @types exercise native triple-reference priority. */
export function installNativeAncestorTypes(ancestor: string, root: string) {
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  const core = (origin: string) =>
    `export interface Marker { origin: "${origin}" }\ndeclare global { const declarationOrigin: "${origin}"; }\n`;
  const install = (directory: string, name: string, version: string, text: string) => {
    write(`${directory}/package.json`, JSON.stringify({ name, version, types: "index.d.ts" }));
    return write(`${directory}/index.d.ts`, text);
  };
  install(
    path.join(ancestor, "node_modules/@types/synthetic-core"),
    "@types/synthetic-core",
    "1.0.0",
    core("ancestor"),
  );
  const wrapper = install(
    "node_modules/.pnpm/wrapper/node_modules/@types/synthetic-wrapper",
    "@types/synthetic-wrapper",
    "1.0.0",
    '/// <reference types="synthetic-core" />\nexport type { Marker } from "synthetic-core";\n',
  );
  const local = install(
    "node_modules/.pnpm/core/node_modules/@types/synthetic-core",
    "@types/synthetic-core",
    "2.0.0",
    core("local"),
  );
  fs.mkdirSync(path.join(root, "node_modules/@types"), { recursive: true });
  fs.symlinkSync(
    path.relative(path.join(root, "node_modules/@types"), path.dirname(wrapper)),
    path.join(root, "node_modules/@types/synthetic-wrapper"),
    "junction",
  );
  const peerRoot = path.dirname(path.dirname(wrapper));
  fs.symlinkSync(
    path.relative(peerRoot, path.dirname(local)),
    path.join(peerRoot, "synthetic-core"),
    "junction",
  );
}
