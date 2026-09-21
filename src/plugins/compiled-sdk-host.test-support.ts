import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPackageDistImports } from "../../scripts/lib/package-dist-imports.mjs";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

type SdkEntrypoint = Parameters<typeof resolveRuntimeWorkerUrl>[0];

/** Keep native SDK consumers on the invocation's verified, current-source graph. */
export function createCompiledSdkHost(
  [entrypoint, ...additionalEntrypoints]: readonly [SdkEntrypoint, ...SdkEntrypoint[]],
  makeTempDir: (prefix: string) => string,
): string | undefined {
  const artifact = fileURLToPath(resolveRuntimeWorkerUrl(entrypoint));
  const artifacts = [
    artifact,
    ...additionalEntrypoints.map((entry) => fileURLToPath(resolveRuntimeWorkerUrl(entry))),
  ];
  // Standalone and watch-mode Vitest deliberately retain source declarations.
  if (artifacts.some((file) => path.extname(file) !== ".js")) {
    return undefined;
  }
  const sourceDist = path.dirname(path.dirname(artifact));
  if (artifacts.some((file) => path.dirname(path.dirname(file)) !== sourceDist)) {
    throw new Error("Compiled SDK entrypoints must share one invocation's dist directory");
  }
  const sourceRoot = path.dirname(sourceDist);
  const files = new Set(
    artifacts.map((file) => path.relative(sourceRoot, file).split(path.sep).join("/")),
  );
  // Version and catalog readers probe this shared asset with computed paths.
  if (fs.existsSync(path.join(sourceDist, "build-info.json"))) {
    files.add("dist/build-info.json");
  }
  const hostRoot = makeTempDir("openclaw-sdk-host-");
  const createdDirectories = new Set<string>();
  let copiedEmbeddedDependencies = false;
  for (const file of files) {
    if (file.startsWith("dist/node_modules/")) {
      if (!copiedEmbeddedDependencies) {
        // Package internals can use bare imports, metadata, and native assets outside the scanner.
        fs.cpSync(path.join(sourceDist, "node_modules"), path.join(hostRoot, "dist/node_modules"), {
          recursive: true,
          mode: fs.constants.COPYFILE_FICLONE,
        });
        copiedEmbeddedDependencies = true;
      }
      continue;
    }
    const source = path.join(sourceRoot, file);
    const target = path.join(hostRoot, file);
    const directory = path.dirname(target);
    if (!createdDirectories.has(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      createdDirectories.add(directory);
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    const imports = collectPackageDistImports({
      files: [file],
      readText: () => fs.readFileSync(source, "utf8"),
    });
    for (const { importedPath } of imports) {
      // Bundled code can also probe optional source-form URLs absent from dist.
      if (
        importedPath.startsWith("dist/") &&
        !files.has(importedPath) &&
        fs.existsSync(path.join(sourceRoot, importedPath))
      ) {
        files.add(importedPath);
      }
    }
  }
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../../package.json"),
    path.join(hostRoot, "package.json"),
  );
  fs.mkdirSync(path.join(hostRoot, "src"));
  fs.mkdirSync(path.join(hostRoot, "extensions"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(hostRoot, "node_modules"), "junction");
  return hostRoot;
}
