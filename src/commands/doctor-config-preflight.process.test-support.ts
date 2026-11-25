import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const execFileAsync = promisify(execFile);
const isolatedRuntimeNodeExecPath = resolveTestNodeExecPath();
// The fixture owns its package assets; resolving linked source back to the checkout
// makes Doctor repair that checkout instead, including building its Control UI.
// Dependency realpaths still own their transitive packages under isolated installs.
export const ISOLATED_RUNTIME_NODE_ARGS = [
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--import",
  `data:text/javascript,${encodeURIComponent(`
    import fs from "node:fs";
    import nodeModule from "node:module";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (!resolved.url.startsWith("file:")) return resolved;
        const filename = fileURLToPath(resolved.url);
        if (!filename.split(path.sep).includes("node_modules")) return resolved;
        const url = new URL(resolved.url);
        url.pathname = pathToFileURL(fs.realpathSync(filename)).pathname;
        return { ...resolved, url: url.href };
      }
    });
  `)}`,
];

export function runBuiltRuntime(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
  options: Pick<Parameters<typeof runCliProcessChild>[0], "maxBuffer" | "onTestFinished"> = {},
) {
  return runCliProcessChild({
    nodeExecutable: isolatedRuntimeNodeExecPath,
    nodeArgs: [...ISOLATED_RUNTIME_NODE_ARGS, path.join(runtimeRoot, "dist", "entry.js"), ...args],
    nodeArgsPolicy: "caller",
    cwd: runtimeRoot,
    env,
    timeoutMs: timeout,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    ...(options.onTestFinished ? { onTestFinished: options.onTestFinished } : {}),
  });
}

export function runSourceRuntime(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
  maxBuffer?: number,
) {
  return runCliProcessChild({
    nodeExecutable: isolatedRuntimeNodeExecPath,
    nodeArgs: [...ISOLATED_RUNTIME_NODE_ARGS, "--import", "tsx", ...args],
    nodeArgsPolicy: "caller",
    cwd: runtimeRoot,
    env,
    timeoutMs: timeout,
    maxBuffer: maxBuffer ?? 1024 * 1024,
  });
}

export function runIsolatedModuleScript(
  env: NodeJS.ProcessEnv,
  script: string,
  options: { runtimeRoot?: string; timeoutMs?: number } = {},
) {
  return execFileAsync(
    isolatedRuntimeNodeExecPath,
    [
      ...(options.runtimeRoot ? ISOLATED_RUNTIME_NODE_ARGS : []),
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: options.runtimeRoot ?? path.resolve("."),
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );
}

export function createSourceRuntime(root: string): string {
  const packageJson: { files: string[] } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
  for (const dirname of ["node_modules", "packages", "scripts", "src", "docs"]) {
    fs.symlinkSync(
      path.resolve(dirname),
      path.join(runtimeRoot, dirname),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const filename of [
    ...packageJson.files.filter((file) => !file.includes("/") && file.endsWith(".mjs")),
    "package.json",
    "tsconfig.json",
  ]) {
    fs.copyFileSync(path.resolve(filename), path.join(runtimeRoot, filename));
  }
  fs.writeFileSync(
    path.join(runtimeRoot, "dist", "build-info.json"),
    JSON.stringify({ builtAt: "2026-08-05T00:00:00.000Z" }),
  );
  const uiDir = path.join(runtimeRoot, "dist", "control-ui");
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>\n");
  return runtimeRoot;
}

export function createBuiltRuntime(
  root: string,
  sourceDist = path.resolve("dist"),
  options: { copyDirectories?: boolean; emptyExtensions?: boolean } = {},
): string {
  const runtimeRoot = createSourceRuntime(root);
  // The pretest owner supplies immutable built modules once; mutable package
  // metadata and Control UI assets remain private to each fixture.
  for (const entry of fs.readdirSync(sourceDist, { withFileTypes: true })) {
    if (entry.name === "build-info.json" || entry.name === "control-ui") {
      continue;
    }
    const source = path.join(sourceDist, entry.name);
    const target = path.join(runtimeRoot, "dist", entry.name);
    if (entry.isDirectory() && entry.name === "extensions" && options.emptyExtensions) {
      fs.mkdirSync(target);
    } else if (entry.isDirectory() && options.copyDirectories) {
      // Direct package entry invocations do not pass --preserve-symlinks.
      fs.cpSync(source, target, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    } else if (entry.isDirectory()) {
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    }
  }
  if (!fs.existsSync(path.join(runtimeRoot, "dist", "entry.js"))) {
    throw new Error("built Doctor fixture requires dist/entry.js; prepare the runtime first");
  }
  return runtimeRoot;
}
