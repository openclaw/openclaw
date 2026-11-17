import fs from "node:fs";
import path from "node:path";
import { relativePluginPathInsideRootSync } from "./path-safety.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import {
  createPluginNativeReferenceValidator,
  linkPluginNativeReference,
} from "./plugin-native-reference.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";
import type { pluginSourceCaptureDirectory } from "./plugin-source-capture-context.js";

export type PluginRecoveryCopyInput = {
  rootDir: string;
  boundaryRoot: string;
  references?: ReadonlyMap<string, PluginNativeArtifactFact>;
  namespaces?: ReadonlyMap<string, PluginNativeNamespaceFact>;
};
export type PluginRecoveryCaptureInput = PluginRecoveryCopyInput & {
  storage: PluginSourceCaptureStorage;
  directory?: ReturnType<typeof pluginSourceCaptureDirectory.getStore>;
};
/** Sync forks and broker-owned async recovery use the same link and native admission policy. */
export function* copyPluginRecoveryFiles(
  input: PluginRecoveryCopyInput,
  directory: string,
): Generator<Parameters<typeof fs.cpSync>, void, void> {
  const { rootDir, boundaryRoot, references, namespaces } = input;
  const fileReferenceTargets = new Map<string, PluginNativeArtifactFact>();
  yield [
    boundaryRoot,
    directory,
    {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from, to) => {
        const fact = references?.get(from);
        if (!fact) {
          const entry = fs.lstatSync(from);
          if (entry.isSymbolicLink()) {
            const target = fs.readlinkSync(from);
            const relative = path.isAbsolute(target)
              ? relativePluginPathInsideRootSync(boundaryRoot, target)
              : undefined;
            if (relative !== undefined) {
              // Windows junctions must stop pointing at the seed before it is retired.
              fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
              fs.symlinkSync(
                path.relative(path.dirname(to), path.join(directory, relative)),
                to,
                fs.statSync(from).isDirectory() ? "junction" : "file",
              );
              return false;
            }
          }
          return true;
        }
        const retained = { ...fact, sourceIdentity: fact.capturedIdentity };
        if (linkPluginNativeReference(fact.capturedPath, to, retained) !== "symlink") {
          fileReferenceTargets.set(to, retained);
        }
        return false;
      },
    },
  ];
  const assertReference = createPluginNativeReferenceValidator(directory, rootDir);
  for (const [target, fact] of fileReferenceTargets) {
    assertReference(target, fact, namespaces!.get(fact.namespace)!);
  }
}
