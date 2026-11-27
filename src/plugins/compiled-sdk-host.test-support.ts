import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProcessDistRoot } from "../../runtime-process-bootstrap.generated.mjs";
import { collectPackageDistImports } from "../../scripts/lib/package-dist-imports.mjs";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

type SdkEntrypoint = Parameters<typeof resolveRuntimeWorkerUrl>[0];

/** Discover once while keeping each consumer's writable host independent. */
export function prepareCompiledSdkHost(
  entrypoints: readonly [SdkEntrypoint, ...SdkEntrypoint[]],
  options: { mode?: "copy" | "link" } = {},
) {
  const artifacts = entrypoints.map((entry) => fileURLToPath(resolveRuntimeWorkerUrl(entry)));
  // Standalone and watch-mode Vitest deliberately retain source declarations.
  if (artifacts.some((file) => path.extname(file) !== ".js")) {
    return () => undefined;
  }
  const [sourceDist, ...otherDists] = artifacts.map(resolveRuntimeProcessDistRoot);
  if (!sourceDist || otherDists.some((dist) => dist !== sourceDist)) {
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
  if (options.mode === "link") {
    files.clear();
  }
  for (const file of files) {
    if (file.startsWith("dist/node_modules/")) {
      continue;
    }
    const source = path.join(sourceRoot, file);
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
  const copiedFiles = [...files].filter((file) => !file.startsWith("dist/node_modules/"));
  const directories = new Set(copiedFiles.map((file) => path.dirname(file)));
  return (makeTempDir: (prefix: string) => string) => {
    const hostRoot = makeTempDir("openclaw-sdk-host-");
    if (options.mode === "link") {
      // Linked consumers retain the invocation's physical modules until their children join.
      fs.symlinkSync(sourceDist, path.join(hostRoot, "dist"), "junction");
    }
    for (const directory of directories) {
      fs.mkdirSync(path.join(hostRoot, directory), { recursive: true });
    }
    if (copiedFiles.length !== files.size) {
      // Bare imports can require package metadata and native assets outside the scanner.
      fs.cpSync(path.join(sourceDist, "node_modules"), path.join(hostRoot, "dist/node_modules"), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    }
    for (const file of copiedFiles) {
      fs.copyFileSync(
        path.join(sourceRoot, file),
        path.join(hostRoot, file),
        fs.constants.COPYFILE_FICLONE,
      );
    }
    fs.copyFileSync(
      path.resolve(import.meta.dirname, "../../package.json"),
      path.join(hostRoot, "package.json"),
    );
    fs.mkdirSync(path.join(hostRoot, "src"));
    fs.mkdirSync(path.join(hostRoot, "extensions"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(hostRoot, "node_modules"), "junction");
    return hostRoot;
  };
}
