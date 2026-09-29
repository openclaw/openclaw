import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type KoffiModule = typeof import("koffi");

function loadedNativeFile(require: NodeJS.Require, koffi: KoffiModule): string {
  // Koffi's public indirect loader exposes the selected addon as default. Follow
  // that successful load so source builds retain the vendor's selection order.
  const loaded = Object.values(require.cache).filter(
    (module) =>
      module?.loaded && module.filename.endsWith(".node") && module.exports === koffi.default,
  );
  if (loaded.length !== 1) {
    throw new Error("Managed handoff could not identify the loaded FreeBSD native runtime");
  }
  return fs.realpathSync(loaded[0]!.filename);
}

/** Keep the native dependency alive through package replacement and triage re-exec. */
export function stageFreeBsdManagedHandoffNativeRuntime(directory: string): string[] {
  if (process.platform !== "freebsd") {
    return [];
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Managed handoff requires a supported FreeBSD native architecture");
  }
  // Koffi adds external search roots for Electron. A sealed handoff may load
  // only its own staged package, including when the original install is gone.
  // SAFETY: This adds only an optional unknown field; every defined value is rejected.
  if ((process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath !== undefined) {
    throw new Error("Managed handoff cannot use an external FreeBSD native resource path");
  }

  const require = createRequire(import.meta.url);
  const entry = fs.realpathSync(require.resolve("koffi/indirect"));
  const sourceRoot = path.dirname(entry);
  const sourceRequire = createRequire(entry);
  // SAFETY: The public Koffi entry supplies this API; version and loaded ownership are checked below.
  const koffi = sourceRequire(entry) as KoffiModule;
  // SAFETY: These fields remain unknown until the name and version checks below.
  const metadata = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    metadata.name !== "koffi" ||
    typeof metadata.version !== "string" ||
    !metadata.version ||
    koffi.version !== metadata.version
  ) {
    throw new Error("Managed handoff FreeBSD native runtime version does not match its package");
  }

  const nativeFile = loadedNativeFile(sourceRequire, koffi);
  const triplet = `freebsd_${process.arch}`;
  const nativeRelative = path.join("build", "koffi", triplet, "koffi.node");
  if (nativeFile !== path.join(sourceRoot, nativeRelative)) {
    const optionalRoot = path.dirname(
      fs.realpathSync(sourceRequire.resolve(`@koromix/koffi-freebsd-${process.arch}`)),
    );
    if (nativeFile !== path.join(optionalRoot, triplet, "koffi.node")) {
      throw new Error("Managed handoff FreeBSD native runtime has an unexpected package path");
    }
  }

  // Copy regular bytes into one canonical build layout. No alternate addon or
  // source symlink may send the private loader back to the mutable installation.
  const files = [
    ...["package.json", "indirect.cjs", "src/koffi/indirect.cjs", "LICENSE.txt"].map(
      (relative) => ({ source: path.join(sourceRoot, relative), relative }),
    ),
    { source: nativeFile, relative: nativeRelative },
  ];
  const privateRoot = path.resolve(directory, "runtime", "node_modules", "koffi");
  const staged = files.map(({ source, relative }) => {
    if (!fs.lstatSync(source).isFile()) {
      throw new Error("Managed handoff FreeBSD native runtime requires regular package files");
    }
    const destination = path.join(privateRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(source), { mode: 0o600, flag: "wx" });
    return destination;
  });

  const privateEntry = path.join(privateRoot, "indirect.cjs");
  const privateRequire = createRequire(privateEntry);
  // SAFETY: This copies the public loader; its version and private native path are checked below.
  const privateKoffi = privateRequire(privateEntry) as KoffiModule;
  if (
    privateKoffi.version !== metadata.version ||
    loadedNativeFile(privateRequire, privateKoffi) !==
      fs.realpathSync(path.join(privateRoot, nativeRelative))
  ) {
    throw new Error("Managed handoff did not load its private FreeBSD native runtime");
  }
  return staged;
}
