import fs from "node:fs";
import path from "node:path";
import { relativePluginPathInsideRootSync } from "./path-safety.js";
import {
  createPluginNativeReferenceValidator,
  linkPluginNativeReference,
} from "./plugin-native-reference.js";
import type { PluginRecoveryCopyInput } from "./plugin-recovery-source-copy.types.js";
import type { PluginNativeArtifactFact } from "./plugin-source-admission.types.js";

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
