import fs from "node:fs";
import path from "node:path";
import {
  resolvePluginModulePackageRoot,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";

export function createPluginGenerationExecutableCapture(params: {
  execute?: <T>(run: () => T) => T;
  packages: ReadonlyMap<string, PluginPackageCapture>;
  copyPackage: (
    root: string,
    entry?: string,
    metadataOnly?: boolean,
    executableEntry?: boolean,
  ) => string;
}) {
  const captureExecutableFile = (filename: string): string | undefined =>
    params.execute?.(() => {
      const real = fs.realpathSync(filename);
      if (!fs.statSync(real).isFile()) {
        return undefined;
      }
      params.copyPackage(resolvePluginModulePackageRoot(real), real, false, true);
      return real;
    });
  const captureExecutableFileAtRoot = (filename: string, sourceRoot: string): string | undefined =>
    params.execute?.(() => {
      params.copyPackage(sourceRoot, filename, false, true);
      return filename;
    });
  const captureExecutableFilesAtRoot = (
    filenames: readonly string[],
    sourceRoot: string,
  ): readonly string[] | undefined =>
    params.execute?.(() => {
      const owner = params.packages.get(sourceRoot);
      if (!owner) {
        throw new Error("Plugin source root is not captured");
      }
      for (const filename of filenames) {
        owner.captureTarget(path.join(owner.capturedRoot, path.relative(sourceRoot, filename)));
      }
      return filenames;
    });
  return { captureExecutableFile, captureExecutableFileAtRoot, captureExecutableFilesAtRoot };
}
