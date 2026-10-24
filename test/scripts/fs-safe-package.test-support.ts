import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const fsSafeRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
const requireFromFsSafe = createRequire(path.join(fsSafeRoot, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(fsSafeRoot, "package.json"), "utf8")) as {
  optionalDependencies: Record<string, string>;
};

// Keep external runtime dependencies available without replacing the copied
// fs-safe/native package whose containment these fixtures prove.
export function linkFsSafeFixtureRuntimeDependencies(
  packageRoot: string,
  chunks: ReadonlyArray<{
    fileName: string;
    imports: readonly string[];
    dynamicImports: readonly string[];
  }>,
) {
  const { dependencies } = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  const emittedFiles = new Set(chunks.map((chunk) => chunk.fileName));
  for (const specifier of new Set(
    chunks.flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports]),
  )) {
    if (isBuiltin(specifier) || specifier.startsWith(".") || emittedFiles.has(specifier)) {
      continue;
    }
    const packageName = specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");
    assert(Object.hasOwn(dependencies, packageName), specifier);
    if (packageName === "@openclaw/fs-safe") {
      continue;
    }
    const destination = path.join(packageRoot, "node_modules", packageName);
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(fs.realpathSync(path.join("node_modules", packageName)), destination, "dir");
    }
  }
}

// Nest platform packages under their declared owner so a hoisted development
// install cannot hide a bundled loader that resolves from the wrong package.
export function copyFsSafePackageFixture(packageRoot: string) {
  const dependencyRoot = path.join(packageRoot, "node_modules/@openclaw/fs-safe");
  fs.cpSync(fsSafeRoot, dependencyRoot, { recursive: true });
  const nativePackages: Array<{ name: string; root: string }> = [];
  for (const name of Object.keys(manifest.optionalDependencies)) {
    if (!name.startsWith("@openclaw/fs-safe-")) {
      continue;
    }
    let installed: string;
    try {
      installed = path.dirname(requireFromFsSafe.resolve(`${name}/package.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
        throw error;
      }
      continue;
    }
    const destination = path.join(dependencyRoot, "node_modules", name);
    fs.cpSync(installed, destination, { recursive: true });
    nativePackages.push({ name, root: destination });
  }
  return { dependencyRoot, nativePackages };
}

/** Keep the real emitted SDK closure and the complete native-package composition. */
export async function copyCompiledFsSafeRuntimeFixture(generation: string, packageRoot: string) {
  const { collectRuntimeImportClosure } =
    await import("../../scripts/lib/runtime-import-closure.mts");
  const repoRoot = process.cwd();
  const entry = path.join(generation, "dist/plugin-sdk/file-access-runtime.js");
  const closure = collectRuntimeImportClosure(repoRoot, [entry], { includeDynamicImports: true });
  // This emitted entry has only local module edges; dynamic native assets stay
  // with the complete installed package and optional dependencies below.
  for (const file of closure) {
    const source = path.resolve(repoRoot, file);
    const relative = path.relative(generation, source);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Compiled fs-safe fixture dependency escaped its generation: ${file}`);
    }
    const destination = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}');
  return copyFsSafePackageFixture(packageRoot);
}
