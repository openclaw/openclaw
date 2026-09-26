import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginCache } from "./plugin-cache.js";
import type { PluginCache } from "./plugin-cache.types.js";
import {
  nativeAdmissionStateFor,
  retainNativePath,
  snapshotOwners,
  startNativeAdmissionPublication,
} from "./plugin-native-admission-state.js";
import {
  assertPluginNativeNamespaceHost,
  capturePluginNativeDirectoryAliases,
  capturePluginNativeNamespace,
  finishPluginNativeNamespace,
  pluginNativeNamespaceDirectory,
  pluginNativeNamespaceBoundary,
  pluginNativeNamespaceIsCurrent,
  pluginNativeNamespaceMemberPath,
  pluginNativeNamespaceMemberRelativePath,
} from "./plugin-native-namespace.js";
import {
  admitPluginNativeRecoveryReference,
  assertPluginNativeReferenceNamespace,
  linkPluginNativeReference,
} from "./plugin-native-reference.js";
import { publishPluginSourceAdmission } from "./plugin-source-admission-store.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";
import {
  createPluginNativeCaptureRoot,
  retainPluginNativeCapturePath,
} from "./plugin-source-capture-directory.js";
import {
  hashPluginSourceFile,
  isPluginNativeExecutable,
  pluginSourceIdentityChangedOnlyByCtime,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";
import type { PluginSourceInput } from "./plugin-source-verification.js";

type NativeSnapshot = ReturnType<typeof createPluginNativeCaptureRoot>;
type NativeReceipt = { signature: string; sourceDigest: string };
export type PluginNativeRecovery = {
  receipt: NativeReceipt;
  references: Map<string, PluginNativeArtifactFact>;
  namespaces: Map<string, PluginNativeNamespaceFact>;
  directories: Map<string, string>;
  retain(cache: PluginCache): void;
  dispose(): void;
  disposeAsync(): Promise<void>;
};
// Recovery custody contains copied paths and native roots, never the retired registry or instance.
function createNativeRecovery(
  receipt: NativeReceipt,
  references: Map<string, PluginNativeArtifactFact>,
  namespaces: Map<string, PluginNativeNamespaceFact>,
  directories: Map<string, string>,
  roots: NativeSnapshot[],
): PluginNativeRecovery {
  const custody = {};
  const paths = [...references.values()].map((fact) => fact.capturedPath);
  paths.push(...[...namespaces.keys()].map((root) => path.join(root, "content")));
  const pins = [...new Set(paths)].map(retainPluginNativeCapturePath);
  for (const root of roots) {
    snapshotOwners.get(root)!.add(custody);
  }
  let disposed = false;
  const release = () => {
    if (disposed) {
      return [];
    }
    disposed = true;
    for (const pin of pins) {
      pin();
    }
    return roots.filter((root) => {
      const owners = snapshotOwners.get(root)!;
      owners.delete(custody);
      return owners.size === 0;
    });
  };
  return {
    receipt: { ...receipt },
    references,
    namespaces,
    directories,
    retain(cache) {
      if (disposed) {
        throw new Error("Plugin native recovery has been disposed");
      }
      const state = nativeAdmissionStateFor(cache);
      for (const [key, namespace] of namespaces) {
        state.namespaces.set(key, namespace);
        retainNativePath(state, path.join(key, "content"));
      }
      for (const root of roots) {
        state.roots.add(root);
        snapshotOwners.get(root)!.add(state);
      }
      for (const fact of references.values()) {
        retainNativePath(state, fact.capturedPath);
      }
    },
    dispose() {
      for (const root of release()) {
        root.dispose();
      }
    },
    async disposeAsync() {
      await Promise.all(release().map((root) => root.disposeAsync()));
    },
  };
}

function isNativeArtifact(
  source: string,
  boundary: string,
  stat: fs.BigIntStats,
  known: boolean,
): boolean {
  return (
    /\.(?:node|so(?:\.\d+)*|dylib|dll|exe|bin)$/i.test(source) ||
    ((stat.mode & 0o111n) !== 0n &&
      path.extname(source) === "" &&
      (known || isPluginNativeExecutable(source, boundary)))
  );
}

/** Admission is shared below registration; each generation still owns its module graph. */
export function createPluginNativeAdmission(
  rootDir: string,
  directory: string,
  entryFile?: string,
  recovery?: PluginNativeRecovery,
  outputRoot?: string,
) {
  recovery?.retain(getPluginCache());
  const state = nativeAdmissionStateFor();
  const key = `${path.resolve(rootDir)}\0${entryFile ? path.resolve(entryFile) : ""}`;
  const owner = state.owners.get(path.resolve(rootDir));
  const prepared = recovery?.receipt ?? state.receipts.get(key);
  const selected = new Map<string, PluginNativeNamespaceFact>();
  const priorNamespaces = new Set<PluginNativeNamespaceFact>();
  const files = new Map<string, PluginNativeArtifactFact>();
  const targets = new Map<string, string>();
  const hardlinkedTargets = new Set<string>();
  const recoveredFiles = new Map<string, PluginNativeArtifactFact>();
  let hostRoot: string | undefined;
  let finalReceipt: NativeReceipt | undefined;
  const namespaces = () => [...new Set(selected.values())];
  for (const [alias, id] of recovery?.directories ?? []) {
    const namespace = state.namespaces.get(id);
    if (namespace) {
      selected.set(alias, namespace);
    }
  }
  const namespaceFor = (source: string) =>
    [...selected]
      .toSorted(([left], [right]) => right.length - left.length)
      .find(([alias]) => isPathInside(alias, source));
  const resolvePreparedSource = (source: string) => {
    const file = files.get(path.resolve(source));
    if (file) {
      return {
        path: file.capturedPath,
        boundary: pluginNativeNamespaceBoundary(state.namespaces.get(file.namespace)!),
      };
    }
    if (!recovery) {
      for (const namespace of namespaces()) {
        const member = Object.entries(namespace.members).find(
          ([, value]) => value.source === source,
        );
        if (member) {
          return {
            path: pluginNativeNamespaceMemberPath(namespace, member[0]),
            boundary: pluginNativeNamespaceBoundary(namespace),
          };
        }
      }
    }
    const found = namespaceFor(path.resolve(source));
    return found
      ? {
          path: path.join(
            pluginNativeNamespaceDirectory(found[1]),
            path.relative(found[0], path.resolve(source)),
          ),
          boundary: pluginNativeNamespaceBoundary(found[1]),
        }
      : undefined;
  };
  const sourceForPrepared = (filename: string) => {
    for (const [alias, namespace] of selected) {
      const root = pluginNativeNamespaceDirectory(namespace);
      if (isPathInside(root, filename)) {
        const relative = path.relative(root, filename);
        return (!recovery && namespace.members[relative]?.source) || path.join(alias, relative);
      }
    }
    return undefined;
  };
  const createNamespace = (
    sourceDirectory: string,
    boundary: string,
    managed: boolean,
    previous?: PluginNativeNamespaceFact,
    retainedRoot?: string,
  ) => {
    const root = createPluginNativeCaptureRoot();
    state.roots.add(root);
    snapshotOwners.set(root, new Set([state]));
    const { fact } = capturePluginNativeNamespace({
      sourceDirectory,
      boundary,
      managed,
      previous,
      retainedRoot,
      managedRoots: [...state.managedRoots.keys()],
      capturedRoot: root.directory,
      outputRoot,
      inspectionRoots: [...new Set([boundary, ...(owner ? [owner.rootDir] : [])])],
      inspectedFiles: [owner?.source, owner?.setupSource, entryFile].filter(
        (file): file is string => Boolean(file),
      ),
    });
    state.namespaces.set(root.directory, fact);
    return fact;
  };
  const publish = () => {
    if (!finalReceipt || files.size === 0) {
      return;
    }
    for (const [source, fact] of files) {
      state.files.set(source, fact);
      retainNativePath(state, fact.capturedPath);
      retainNativePath(state, path.join(fact.namespace, "content"));
    }
    const used = new Set([...files.values()].map((fact) => fact.namespace));
    const nativeNamespaces = Object.fromEntries(
      [...used].map((id) => [id, state.namespaces.get(id)!]),
    );
    const next = structuredClone({
      ...finalReceipt,
      nativeArtifacts: Object.fromEntries(files),
      nativeNamespaces,
    });
    const unchanged = isDeepStrictEqual(state.receipts.get(key), next);
    state.receipts.set(key, next);
    if (!owner) {
      return;
    }
    if (unchanged) {
      startNativeAdmissionPublication(state, key);
      return;
    }
    const roots = [...state.roots].filter((root) => used.has(root.directory));
    const publication = () =>
      publishPluginSourceAdmission({
        pluginId: owner.pluginId,
        rootDir: owner.rootDir,
        installRecordHash: owner.installRecordHash,
        key,
        receipt: next,
      })
        .then((accepted) => {
          if (accepted) {
            for (const root of roots) {
              root.commit();
            }
            if (state.publications.get(key) === publication) {
              state.publications.delete(key);
            }
          }
        })
        .catch((error: unknown) =>
          process.emitWarning(`Plugin source receipt was not recorded: ${String(error)}`),
        );
    state.publications.set(key, publication);
    startNativeAdmissionPublication(state, key);
  };
  const refreshReference = (fact: PluginNativeArtifactFact, input: string, target: string) => {
    const namespace = state.namespaces.get(fact.namespace)!;
    const relative = pluginNativeNamespaceMemberRelativePath(namespace, fact.capturedPath);
    const member = namespace.members[relative]!;
    const linked = {
      ...fact,
      sourceIdentity: pluginSourceStatIdentity(fs.statSync(input, { bigint: true })),
    };
    if (linkPluginNativeReference(input, target, linked) === "hardlink") {
      hardlinkedTargets.add(target);
    } else {
      hardlinkedTargets.delete(target);
    }
    const oldIdentity = member.capturedIdentity;
    member.capturedIdentity = linked.capturedIdentity;
    if (member.sourceIdentity === oldIdentity) {
      member.sourceIdentity = linked.capturedIdentity;
    }
    fact.sourceIdentity = member.sourceIdentity;
    fact.capturedIdentity = linked.capturedIdentity;
    return linked.sourceIdentity;
  };
  const assertReferenceNamespaces = () => {
    for (const target of hardlinkedTargets) {
      const fact = files.get(targets.get(target)!)!;
      assertPluginNativeReferenceNamespace(
        target,
        fact,
        state.namespaces.get(fact.namespace)!,
        directory,
        hostRoot,
      );
    }
  };
  const linkHost = (selectedHost: string): void => {
    hostRoot = fs.realpathSync(selectedHost);
    for (const namespace of namespaces()) {
      if (namespace.referenceRoot) {
        assertPluginNativeNamespaceHost(namespace, hostRoot);
        continue;
      }
      const link = path.join(namespace.capturedRoot, "node_modules", "openclaw");
      const present = fs.lstatSync(link, { throwIfNoEntry: false });
      if (present && fs.realpathSync(link) !== hostRoot) {
        const replacement = createNamespace(
          namespace.sourceDirectory,
          namespace.sourceDirectory,
          namespace.managed,
          namespace,
        );
        // Inputs already captured from the old SDK namespace retain its freshly verified identities.
        priorNamespaces.add(namespace);
        fs.mkdirSync(path.join(replacement.capturedRoot, "node_modules"), {
          recursive: true,
          mode: 0o700,
        });
        fs.symlinkSync(
          hostRoot,
          path.join(replacement.capturedRoot, "node_modules", "openclaw"),
          "junction",
        );
        for (const [alias, selectedNamespace] of selected) {
          if (selectedNamespace === namespace) {
            selected.set(alias, replacement);
          }
        }
        for (const [source, fact] of files) {
          if (fact.namespace !== namespace.capturedRoot) {
            continue;
          }
          const relative = pluginNativeNamespaceMemberRelativePath(namespace, fact.capturedPath);
          const member = replacement.members[relative]!;
          files.set(source, {
            ...fact,
            namespace: replacement.capturedRoot,
            capturedPath: path.join(pluginNativeNamespaceDirectory(replacement), relative),
            capturedIdentity: member.capturedIdentity,
            sourceIdentity: member.sourceIdentity,
          });
        }
        for (const [target, source] of targets) {
          const fact = files.get(source)!;
          if (fact.namespace !== replacement.capturedRoot) {
            continue;
          }
          fs.unlinkSync(target);
          refreshReference(fact, fact.capturedPath, target);
        }
      } else if (!present) {
        fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
        try {
          fs.symlinkSync(hostRoot, link, "junction");
        } catch (error) {
          if (!hasErrnoCode(error, "EEXIST")) {
            throw error;
          }
          if (fs.realpathSync(link) !== hostRoot) {
            return linkHost(hostRoot);
          }
        }
      }
    }
  };
  return {
    prepared,
    resolvePreparedSource,
    sourceForPrepared,
    reconcileSourceInputs(inputs: Map<string, PluginSourceInput>) {
      for (const namespace of new Set([...priorNamespaces, ...namespaces()])) {
        for (const [relative, member] of Object.entries(namespace.members)) {
          if (member.sizeBytes === undefined) {
            continue;
          }
          const capturedPath = pluginNativeNamespaceMemberPath(namespace, relative);
          for (const [source, identity] of [
            [member.source, member.sourceIdentity],
            [capturedPath, member.capturedIdentity],
          ] as const) {
            const input = inputs.get(source);
            if (!input || input.identity === identity) {
              continue;
            }
            if (!pluginSourceIdentityChangedOnlyByCtime(input.identity, identity)) {
              throw new Error("Plugin source changed during native namespace admission");
            }
            member.contentHash ??= hashPluginSourceFile(
              capturedPath,
              pluginNativeNamespaceBoundary(namespace),
            ).contentHash;
            if (input.contentHash !== member.contentHash) {
              throw new Error("Plugin source changed during native namespace admission");
            }
            input.identity = identity;
          }
        }
      }
    },
    captureRecovery(
      receipt: NativeReceipt,
      packageRoots: Readonly<Record<string, string>>,
    ): PluginNativeRecovery {
      const references = new Map(
        [...targets].map(([target, source]) => [target, { ...files.get(source)! }]),
      );
      const used = new Set([...references.values()].map((fact) => fact.namespace));
      return createNativeRecovery(
        receipt,
        references,
        new Map([...used].map((id) => [id, structuredClone(state.namespaces.get(id)!)])),
        capturePluginNativeDirectoryAliases(selected, packageRoots),
        [...state.roots].filter((root) => used.has(root.directory)),
      );
    },
    isRetainedReference(this: void, source: string, real?: string) {
      const fact = recovery?.references.get(path.resolve(source));
      if (!fact) {
        return false;
      }
      const canonical = real ?? fs.realpathSync(source);
      const admitted = admitPluginNativeRecoveryReference(
        canonical,
        fact,
        recoveredFiles.get(canonical),
      );
      if (!admitted) {
        return false;
      }
      recoveredFiles.set(canonical, admitted);
      return true;
    },
    materialize(
      source: string,
      boundary: string,
      target: string,
      stat: fs.BigIntStats,
      logicalSource = sourceForPrepared(source) ?? source,
    ) {
      const recovered = recoveredFiles.get(source);
      const resolvedSource = sourceForPrepared(source) ?? source;
      const known = files.get(logicalSource) ?? state.files.get(logicalSource) ?? recovered;
      if (
        owner?.source === logicalSource ||
        owner?.setupSource === logicalSource ||
        entryFile === logicalSource
      ) {
        return undefined;
      }
      if (!isNativeArtifact(source, boundary, stat, Boolean(known))) {
        return undefined;
      }
      const found = namespaceFor(resolvedSource);
      let namespace = recovered
        ? state.namespaces.get(recovered.namespace)
        : (namespaces().find((candidate) =>
            Object.values(candidate.members).some((member) => member.source === resolvedSource),
          ) ?? found?.[1]);
      let alias = found?.[0] ?? path.dirname(resolvedSource);
      if (!namespace) {
        const tree = [...state.managedRoots].find(([root]) => isPathInside(root, resolvedSource));
        const managed = Boolean(tree);
        // Managed installs retain native names without copying bytes. Mutable checkouts get one
        // bounded namespace snapshot so old generations keep their native bytes after an edit.
        const admittedBoundary = tree?.[0] ?? boundary;
        const preferred = known && state.namespaces.get(known.namespace);
        const candidates = [
          ...new Set([
            ...(preferred ? [preferred] : []),
            ...[...state.namespaces.values()].toReversed(),
          ]),
        ];
        namespace = candidates.find((candidate) => {
          if (
            !isPathInside(candidate.sourceDirectory, resolvedSource) ||
            candidate.managed !== managed ||
            (candidate.referenceRoot !== undefined &&
              (tree?.[1] !== "retained-npm" || candidate.referenceRoot !== tree[0]))
          ) {
            return false;
          }
          try {
            return pluginNativeNamespaceIsCurrent(candidate, admittedBoundary, outputRoot);
          } catch {
            return false;
          }
        });
        namespace ??= createNamespace(
          alias,
          admittedBoundary,
          managed,
          undefined,
          tree?.[1] === "retained-npm" ? tree[0] : undefined,
        );
        alias = namespace.sourceDirectory;
        selected.set(alias, namespace);
      } else if (recovered) {
        alias = [...selected].find(([, candidate]) => candidate === namespace)?.[0] ?? alias;
      }
      const relative = recovered
        ? pluginNativeNamespaceMemberRelativePath(namespace, recovered.capturedPath)
        : (Object.entries(namespace.members).find(
            ([, member]) => member.source === resolvedSource,
          )?.[0] ?? path.relative(alias, resolvedSource));
      const member = namespace.members[relative];
      if (!member || member.sizeBytes === undefined) {
        throw new Error("Native plugin artifact is outside its admitted directory");
      }
      const fact: PluginNativeArtifactFact = {
        sourceIdentity: member.sourceIdentity,
        contentHash: member.contentHash ?? "",
        sizeBytes: member.sizeBytes,
        namespace: namespace.capturedRoot,
        capturedPath: pluginNativeNamespaceMemberPath(namespace, relative),
        capturedIdentity: member.capturedIdentity,
      };
      const inputIdentity = refreshReference(fact, source, target);
      files.set(logicalSource, fact);
      targets.set(target, logicalSource);
      return {
        fact,
        path: fact.capturedPath,
        boundary: pluginNativeNamespaceBoundary(namespace),
        sourceIdentity: inputIdentity,
        sourceBoundary: path.dirname(source),
        content: fact.contentHash
          ? { contentHash: fact.contentHash, sizeBytes: fact.sizeBytes }
          : undefined,
        record(content: { contentHash: string; sizeBytes: number }) {
          Object.assign(fact, content);
          Object.assign(member, content);
          for (const other of namespaces()) {
            for (const sibling of Object.values(other.members)) {
              if (sibling.sizeBytes !== content.sizeBytes || sibling.contentHash) {
                continue;
              }
              if (
                (sibling.source === member.source &&
                  sibling.sourceIdentity === member.sourceIdentity) ||
                sibling.capturedIdentity.split(":").slice(0, 2).join(":") ===
                  member.capturedIdentity.split(":").slice(0, 2).join(":")
              ) {
                Object.assign(sibling, content);
              }
            }
          }
        },
      };
    },
    finish(_captureDirectory: string, receipt: NativeReceipt) {
      if (!files.size) {
        return;
      }
      for (const namespace of namespaces()) {
        finishPluginNativeNamespace(namespace);
      }
      finalReceipt = receipt;
      if (hostRoot) {
        linkHost(hostRoot);
      }
      assertReferenceNamespaces();
      publish();
    },
    linkHost(selectedHost: string) {
      linkHost(selectedHost);
      assertReferenceNamespaces();
      publish();
      return new Map([...files].map(([source, fact]) => [source, fact.sourceIdentity]));
    },
  };
}
