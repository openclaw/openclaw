import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type IdentityModule = typeof import("@openclaw/proc-safe/identity");

function packageMetadata(
  root: string,
  name: string,
): { version: string; optionalDependencies?: Record<string, string> } {
  // SAFETY: Package metadata is checked before using its version or dependency pin.
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    optionalDependencies?: Record<string, string>;
  };
  if (metadata.name !== name || typeof metadata.version !== "string" || !metadata.version) {
    throw new Error("Managed handoff FreeBSD native runtime has invalid package metadata");
  }
  return { version: metadata.version, optionalDependencies: metadata.optionalDependencies };
}

function loadedNativeFile(require: NodeJS.Require, root: string): string {
  const file = path.join(root, "proc-safe-native.node");
  if (!fs.lstatSync(file).isFile()) {
    throw new Error("Managed handoff FreeBSD native runtime requires regular package files");
  }
  const expected = fs.realpathSync(file);
  const loaded = require.cache[expected];
  if (!loaded?.loaded || loaded.filename !== expected) {
    throw new Error("Managed handoff could not identify the loaded FreeBSD native runtime");
  }
  return expected;
}

function runtimeFiles(root: string, relative = "dist"): string[] {
  const directory = path.join(root, relative);
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error("Managed handoff FreeBSD native runtime requires regular package directories");
  }
  return fs
    .readdirSync(directory)
    .toSorted()
    .flatMap((name) => {
      const child = path.join(relative, name);
      const entry = fs.lstatSync(path.join(root, child));
      if (entry.isDirectory()) {
        return runtimeFiles(root, child);
      }
      if (!entry.isFile()) {
        throw new Error("Managed handoff FreeBSD native runtime requires regular package files");
      }
      return name.endsWith(".js") ? [child] : [];
    });
}

/** Keep the native dependency alive through package replacement and triage re-exec. */
export function stageFreeBsdManagedHandoffNativeRuntime(directory: string): string[] {
  if (process.platform !== "freebsd") {
    return [];
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Managed handoff requires a supported FreeBSD native architecture");
  }
  // SAFETY: This adds only an optional unknown field; every defined value is rejected.
  if ((process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath !== undefined) {
    throw new Error("Managed handoff cannot use an external FreeBSD native resource path");
  }

  const require = createRequire(import.meta.url);
  const sourceRoot = path.dirname(require.resolve("@openclaw/proc-safe/package.json"));
  const entry = require.resolve("@openclaw/proc-safe/identity");
  if (entry !== path.join(sourceRoot, "dist", "identity.js") || fs.realpathSync(entry) !== entry) {
    throw new Error("Managed handoff FreeBSD identity entry has an unexpected package path");
  }
  const relativeFiles = ["package.json", "LICENSE", ...runtimeFiles(sourceRoot)];
  for (const relative of relativeFiles) {
    if (!fs.lstatSync(path.join(sourceRoot, relative)).isFile()) {
      throw new Error("Managed handoff FreeBSD native runtime requires regular package files");
    }
  }
  const sourceRequire = createRequire(entry);
  const platformName = `@openclaw/proc-safe-freebsd-${process.arch}`;
  const nativeFile = sourceRequire.resolve(platformName);
  const nativeRoot = path.dirname(sourceRequire.resolve(`${platformName}/package.json`));
  if (
    nativeFile !== path.join(nativeRoot, "proc-safe-native.node") ||
    !fs.lstatSync(nativeFile).isFile()
  ) {
    throw new Error("Managed handoff FreeBSD native runtime has an unexpected package path");
  }
  const metadata = packageMetadata(sourceRoot, "@openclaw/proc-safe");
  const nativeMetadata = packageMetadata(nativeRoot, platformName);
  if (metadata.optionalDependencies?.[platformName] !== nativeMetadata.version) {
    throw new Error("Managed handoff FreeBSD native runtime version does not match its package");
  }
  // SAFETY: The public subpath supplies this API; its self observation loads the selected addon.
  const identity = sourceRequire(entry) as IdentityModule;
  const observed = identity.readProcessIdentity(process.pid);
  if (observed?.startTimeSinceBootMicros === undefined) {
    throw new Error("Managed handoff could not read its FreeBSD process identity");
  }
  loadedNativeFile(sourceRequire, nativeRoot);

  const privateModules = path.resolve(directory, "runtime", "node_modules");
  const files = [
    ...relativeFiles.map((relative) => ({
      source: path.join(sourceRoot, relative),
      destination: path.join(privateModules, "@openclaw", "proc-safe", relative),
    })),
    ...["package.json", "proc-safe-native.node"].map((relative) => ({
      source: path.join(nativeRoot, relative),
      destination: path.join(privateModules, platformName, relative),
    })),
  ];
  const staged = files.map(({ source, destination }) => {
    if (!fs.lstatSync(source).isFile()) {
      throw new Error("Managed handoff FreeBSD native runtime requires regular package files");
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(source), { mode: 0o600, flag: "wx" });
    return destination;
  });

  const privateEntry = path.join(privateModules, "@openclaw", "proc-safe", "dist", "identity.js");
  const privateRequire = createRequire(privateEntry);
  // SAFETY: This is the copied public entry, resolved only inside the private package tree.
  const privateIdentity = privateRequire(privateEntry) as IdentityModule;
  if (
    privateIdentity.readProcessIdentity(process.pid)?.startTimeSinceBootMicros !==
      observed.startTimeSinceBootMicros ||
    loadedNativeFile(privateRequire, path.join(privateModules, platformName)) !==
      fs.realpathSync(path.join(privateModules, platformName, "proc-safe-native.node"))
  ) {
    throw new Error("Managed handoff did not load its private FreeBSD native runtime");
  }
  return staged;
}
