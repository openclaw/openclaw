import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import {
  markPluginSourceCaptureOperation,
  restorePluginRecoverySourceResolver,
  snapshotPluginRecoverySourceResolver,
  type PluginRecoverySource,
} from "./plugin-generation-source-lookup.js";
import type { PluginFrozenSourceSnapshot } from "./plugin-generation-source.types.js";
import { markPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";

/** Own immutable source mapping and recovery policy independently of the capture engine. */
export function createPluginFrozenGeneration(
  snapshot: PluginFrozenSourceSnapshot,
  create: (resolveInput: (filename: string) => string) => PluginGenerationArtifact,
): PluginGenerationArtifact {
  const aliases = Object.entries(snapshot.sourceAliases).toSorted(
    ([left], [right]) => right.length - left.length,
  );
  const links = [...snapshot.sourceLinks].toSorted(([left], [right]) => right.length - left.length);
  const inputFor = (filename: string) => {
    let input = path.resolve(filename);
    const alias = aliases.find(([source]) => isPathInside(source, input));
    if (alias) {
      input = path.join(alias[1], path.relative(alias[0], input));
    }
    for (let pass = 0; pass <= links.length; pass++) {
      const link = links.find(([source]) => isPathInside(source, input));
      if (!link) {
        return input;
      }
      input = path.join(link[1], path.relative(link[0], input));
    }
    throw new PluginSnapshotDependencyError(filename);
  };
  const assertInput = (filename: string) => {
    if (!snapshot.sourcePaths.has(inputFor(filename))) {
      throw new PluginSnapshotDependencyError(filename);
    }
  };
  const frozenInput = (filename: string) => {
    assertInput(filename);
    return inputFor(filename);
  };
  const artifact = create(frozenInput);
  if (artifact.sourceDigest !== snapshot.sourceDigest) {
    artifact.dispose();
    throw new Error("Plugin snapshot runtime receipt differs from its immutable source receipt");
  }
  const capturedAliases = Object.entries(artifact.sourceAliases).toSorted(
    ([, left], [, right]) => right.length - left.length,
  );
  const sourceInputFor = (filename: string) => {
    const input = artifact.sourceForCaptured(filename);
    if (input) {
      return input;
    }
    const alias = capturedAliases.find(([, captured]) => isPathInside(captured, filename));
    return alias ? path.join(alias[0], path.relative(alias[1], filename)) : filename;
  };
  const assertFrozenModule = (filename: string) => assertInput(sourceInputFor(filename));
  const originalFor = (filename: string) => {
    const alias = aliases.find(([, captured]) => isPathInside(captured, filename));
    return alias ? path.join(alias[0], path.relative(alias[1], filename)) : filename;
  };
  const ownedAliases = Object.fromEntries(
    aliases.map(([original, input]) => [original, artifact.sourceAliases[input]!]),
  );
  const runtimeFor = (input: string) => {
    const alias = capturedAliases.find(([source]) => isPathInside(source, input));
    return alias ? path.join(alias[1], path.relative(alias[0], input)) : input;
  };
  const freezeRecovery = (
    recovery: PluginRecoverySource,
    from: string,
    sourceAliases: Readonly<Record<string, string>>,
    sourceLinks: ReadonlyMap<string, string>,
    sourceHardlinks: ReadonlySet<string>,
  ): PluginRecoverySource => {
    const directory = recovery.sourceCapture.directory;
    const relocate = (filename: string) => path.join(directory, path.relative(from, filename));
    const resolver = snapshotPluginRecoverySourceResolver(recovery.resolve)!;
    const sources = new Map(resolver.sources);
    for (const [source, captured] of resolver.sources) {
      sources.set(originalFor(source), captured);
    }
    recovery.resolve = restorePluginRecoverySourceResolver({ ...resolver, sources });
    const nextAliases = Object.fromEntries(
      Object.entries(sourceAliases).map(([source, captured]) => [source, relocate(captured)]),
    );
    const nextLinks = new Map(
      [...sourceLinks].map(([source, target]) => [relocate(source), relocate(target)]),
    );
    const nextHardlinks = new Set([...sourceHardlinks].map(relocate));
    recovery.frozenSource = {
      rootDir: recovery.rootDir,
      sourceRoot: snapshot.sourceRoot,
      sourceAliases: nextAliases,
      sourcePaths: new Set([...sources.values(), ...recovery.directories]),
      sourceLinks: nextLinks,
      sourceHardlinks: nextHardlinks,
      sourceDigest: snapshot.sourceDigest,
    };
    const fork = recovery.fork;
    recovery.fork = markPluginSourceCaptureOperation(() =>
      freezeRecovery(fork(), directory, nextAliases, nextLinks, nextHardlinks),
    );
    return recovery;
  };
  const recover = () =>
    freezeRecovery(
      artifact.captureRecoverySource(),
      artifact.boundaryRoot,
      ownedAliases,
      new Map(
        [...snapshot.sourceLinks].map(([source, target]) => [
          runtimeFor(source),
          runtimeFor(target),
        ]),
      ),
      new Set([...snapshot.sourceHardlinks].map(runtimeFor)),
    );
  // Complete receipt facts stay in the worker until custody is explicitly requested.
  const runtimeArtifact = { ...artifact };
  delete runtimeArtifact.sourceSnapshotFacts;
  return {
    ...runtimeArtifact,
    sourceRoot: snapshot.sourceRoot,
    sourceAliases: {
      ...artifact.sourceAliases,
      ...ownedAliases,
    },
    frozenSource: true,
    assertFrozenModule,
    captureRecoverySource: markPluginSourceCaptureOperation(recover),
    retainSourceCustody: markPluginSourceCaptureOperation(() => ({
      source: recover(),
      files: artifact.sourceSnapshotFacts!.files,
    })),
    hasSource: (source) => snapshot.sourcePaths.has(inputFor(sourceInputFor(source))),
    resolve: (source, rejectHardlinks) => {
      const input = inputFor(sourceInputFor(source));
      assertInput(input);
      if (rejectHardlinks && snapshot.sourceHardlinks.has(input)) {
        throw markPluginSourceAcquisitionError(
          new Error("Plugin source is hardlinked; use a separate file and reload."),
        );
      }
      return artifact.captureResolvedModule(input) ?? artifact.resolve(input, rejectHardlinks);
    },
    sourceForCaptured: (source) => {
      const input = artifact.sourceForCaptured(source);
      return input ? originalFor(input) : undefined;
    },
  };
}
