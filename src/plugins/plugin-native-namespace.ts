import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  capturePluginDependencies,
  createPluginDependencyResolver,
  resolvePluginModulePackageRoot,
} from "./plugin-package-metadata-capture.js";
import { collectPluginSafetyInspectedFiles } from "./plugin-safety-inspected-files.js";
import type { PluginNativeNamespaceFact } from "./plugin-source-admission.types.js";
import {
  copyPluginSourceFile,
  hashPluginSourceFile,
  inspectPluginSourceDescriptor,
  isPluginNativeExecutable,
  isPluginSourceEntry,
  linkPluginSourceFile,
  pluginSourceIdentityChangedOnlyByCtime,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";

type NamespaceMember = {
  source: string;
  identity: string;
  stat: fs.BigIntStats;
  boundary: string;
  linkTo?: string;
};

export type PluginNativeCaptureHooks = {
  onDirectoryEntry?: () => void;
  onSourceDescriptor?: (source: string, stat: fs.BigIntStats, admittedHardlink?: boolean) => void;
};

export function isPluginNativeArtifact(
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
const nativeSourceMembers = new WeakMap<PluginNativeNamespaceFact, Map<string, string>>();
export const pluginNativeNamespaceDirectory = (fact: PluginNativeNamespaceFact) =>
  fact.referenceRoot ? fact.sourceDirectory : path.join(fact.capturedRoot, "content");
export const pluginNativeNamespaceBoundary = (fact: PluginNativeNamespaceFact) =>
  fact.referenceRoot ?? fact.capturedRoot;
export const pluginNativeNamespaceMemberPath = (
  fact: PluginNativeNamespaceFact,
  relative: string,
) =>
  fact.referenceRoot
    ? fact.members[relative]!.source
    : path.join(fact.capturedRoot, "content", relative);

export const pluginNativeNamespaceMemberRelativePath = (
  fact: PluginNativeNamespaceFact,
  filename: string,
) =>
  fact.referenceRoot
    ? Object.entries(fact.members).find(([, member]) => member.source === filename)![0]
    : path.relative(pluginNativeNamespaceDirectory(fact), filename);

export function pluginNativeNamespaceMemberForSource(
  namespace: PluginNativeNamespaceFact,
  source: string,
) {
  const relative = path.relative(namespace.sourceDirectory, source);
  if (namespace.members[relative]?.source === source) {
    return relative;
  }
  let members = nativeSourceMembers.get(namespace);
  if (!members) {
    members = new Map<string, string>();
    for (const [key, { source: memberSource }] of Object.entries(namespace.members)) {
      members.set(memberSource, members.get(memberSource) ?? key);
    }
    nativeSourceMembers.set(namespace, members);
  }
  return members.get(source);
}

/** Recover the two admission-owned names written by receipts predating link inventories. */
export function upgradeLegacyPluginNativeNamespaceHardlinks(fact: PluginNativeNamespaceFact): void {
  for (const [relative, member] of Object.entries(fact.members)) {
    if (member.admissionHardlinks) {
      continue;
    }
    const capturedPath = pluginNativeNamespaceMemberPath(fact, relative);
    if (capturedPath === member.source) {
      continue;
    }
    const source = fs.lstatSync(member.source, { bigint: true, throwIfNoEntry: false });
    const captured = fs.lstatSync(capturedPath, { bigint: true, throwIfNoEntry: false });
    if (
      !source?.isFile() ||
      !captured?.isFile() ||
      source.dev !== captured.dev ||
      source.ino !== captured.ino ||
      source.nlink !== 2n ||
      captured.nlink !== 2n ||
      (pluginSourceStatIdentity(source) !== member.sourceIdentity &&
        !pluginSourceIdentityChangedOnlyByCtime(
          member.sourceIdentity,
          pluginSourceStatIdentity(source),
        )) ||
      (pluginSourceStatIdentity(captured) !== member.capturedIdentity &&
        !pluginSourceIdentityChangedOnlyByCtime(
          member.capturedIdentity,
          pluginSourceStatIdentity(captured),
        ))
    ) {
      continue;
    }
    member.admissionHardlinks = [member.source, capturedPath];
  }
}

export function capturePluginNativeDirectoryAliases(
  selected: ReadonlyMap<string, PluginNativeNamespaceFact>,
  packageRoots: Readonly<Record<string, string>>,
): Map<string, string> {
  const directories = new Map<string, string>();
  for (const [alias, namespace] of selected) {
    const root = Object.keys(packageRoots)
      .filter((candidate) => isPathInside(candidate, alias))
      .toSorted((left, right) => right.length - left.length)[0];
    if (root) {
      directories.set(
        path.join(packageRoots[root]!, path.relative(root, alias)),
        namespace.capturedRoot,
      );
    }
  }
  return directories;
}

/** The installer owns this peer link; a native directory reference must never retarget it. */
export function assertPluginNativeNamespaceHost(
  fact: PluginNativeNamespaceFact,
  hostRoot: string,
  pluginRoot: string,
): void {
  const pluginDirectory = fs.realpathSync(pluginRoot);
  // Hoisted native dependencies need not have a host peer. The admitting plugin does,
  // and any host visible from the native directory must agree with that selection.
  for (const directory of new Set([pluginDirectory, fs.realpathSync(fact.sourceDirectory)])) {
    const candidate = createRequire(path.join(directory, "native-host.cjs"))
      .resolve.paths("openclaw")
      ?.map((modules) => path.join(modules, "openclaw"))
      .find((filename) => fs.existsSync(filename));
    const resolvedHost = candidate ? fs.realpathSync(candidate) : undefined;
    if (
      resolvedHost === hostRoot ||
      (!candidate && (directory !== pluginDirectory || !fact.referenceRoot))
    ) {
      continue;
    }
    throw new Error(
      `Native directory ${fact.sourceDirectory} does not resolve the selected OpenClaw host ${hostRoot}: ` +
        (candidate
          ? `${candidate} resolves to ${resolvedHost}`
          : `no OpenClaw peer resolves from ${directory}`) +
        ". Run openclaw doctor --fix with the selected host to repair the installed plugin's OpenClaw peer link, then reload the plugin.",
    );
  }
}

function readNativeDirectoryNames(directory: string, onEntry?: () => void): string[] {
  const names: string[] = [];
  const handle = fs.opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      onEntry?.();
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  return names.toSorted();
}

function inspectDirectory(
  directory: string,
  boundary: string,
  outputRoot?: string,
  sourceDependencies = true,
  onDirectoryEntry?: () => void,
) {
  const members = new Map<string, NamespaceMember>();
  const directories = new Map<string, string>();
  const ancestors = new Set<string>();
  const resolve = createPluginDependencyResolver();
  const visit = (
    filename: string,
    relative: string,
    packageBoundary: string,
    admittedDependency = false,
  ) => {
    const source = fs.realpathSync(filename);
    if (outputRoot && isPathInside(outputRoot, source)) {
      return;
    }
    if (!isPathInside(packageBoundary, source)) {
      throw new Error(`Native plugin companion leaves its package: ${filename}`);
    }
    const stat = fs.statSync(source, { bigint: true });
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`Native plugin companion is not a regular file: ${filename}`);
    }
    const linkTo = stat.isDirectory() ? directories.get(source) : undefined;
    if (sourceDependencies && !admittedDependency && ancestors.has(source)) {
      throw new Error(`Native plugin companions contain a directory cycle: ${filename}`);
    }
    members.set(relative, {
      source,
      identity: pluginSourceStatIdentity(stat),
      stat,
      boundary: packageBoundary,
      ...(linkTo === undefined ? {} : { linkTo }),
    });
    if (stat.isDirectory()) {
      if (linkTo !== undefined) {
        return;
      }
      directories.set(source, relative);
      ancestors.add(source);
      for (const name of readNativeDirectoryNames(source, onDirectoryEntry)) {
        if (isPluginSourceEntry(name)) {
          visit(path.join(source, name), path.join(relative, name), packageBoundary);
        }
      }
      if (sourceDependencies) {
        const root = relative
          ? source
          : resolvePluginModulePackageRoot(path.join(source, "native-companion.cjs"));
        const manifestFile = path.join(root, "package.json");
        if (isPathInside(packageBoundary, root) && fs.existsSync(manifestFile)) {
          // Use the generation owner's declared dependency selection, each with its own boundary.
          // Only the namespace package and admitted dependencies are selected scopes; other nested
          // manifests resolve what is installed, and Node reports a truly missing import at load.
          capturePluginDependencies({
            root,
            manifestFile,
            incidental: Boolean(relative) && !admittedDependency,
            references: new Map(),
            resolve,
            capture(name, dependency) {
              visit(
                dependency.root,
                path.join(relative, "node_modules", name),
                dependency.root,
                true,
              );
            },
          });
        }
      } else {
        const modules = path.join(source, "node_modules");
        for (const name of fs.existsSync(modules)
          ? readNativeDirectoryNames(modules, onDirectoryEntry)
          : []) {
          const names = name.startsWith("@")
            ? readNativeDirectoryNames(path.join(modules, name), onDirectoryEntry).map(
                (entry) => `${name}/${entry}`,
              )
            : [name];
          for (const dependency of names) {
            if (dependency !== "openclaw" && dependency !== "@openclaw/plugin-sdk") {
              visit(
                path.join(modules, dependency),
                path.join(relative, "node_modules", dependency),
                boundary,
              );
            }
          }
        }
      }
      ancestors.delete(source);
    }
  };
  visit(directory, "", boundary);
  return members;
}

/** Both names and file identities must match: new, removed, and edited companions invalidate reuse. */
export function pluginNativeNamespaceIsCurrent(
  fact: PluginNativeNamespaceFact,
  boundary: string,
  outputRoot?: string,
  onDirectoryEntry?: () => void,
): boolean {
  const source = inspectDirectory(
    fact.sourceDirectory,
    boundary,
    outputRoot,
    true,
    onDirectoryEntry,
  );
  const captured = inspectDirectory(
    pluginNativeNamespaceDirectory(fact),
    pluginNativeNamespaceBoundary(fact),
    fact.referenceRoot ? outputRoot : undefined,
    Boolean(fact.referenceRoot),
    onDirectoryEntry,
  );
  return (
    source.size === Object.keys(fact.members).length &&
    captured.size === source.size &&
    [...source].every(([relative, member]) => {
      const prior = fact.members[relative];
      return (
        prior?.source === member.source &&
        prior.sourceIdentity === member.identity &&
        prior.capturedIdentity === captured.get(relative)?.identity
      );
    })
  );
}

/** A retained namespace is complete before exposing any native pathname from it. */
export function capturePluginNativeNamespace(params: {
  sourceDirectory: string;
  boundary: string;
  capturedRoot: string;
  managed: boolean;
  copyManaged?: boolean;
  outputRoot?: string;
  previous?: PluginNativeNamespaceFact;
  inspectionRoots?: readonly string[];
  inspectedFiles?: readonly string[];
  retainedRoot?: string;
  managedRoots?: readonly string[];
  onDirectoryEntry?: () => void;
  onSourceDescriptor?: (source: string, stat: fs.BigIntStats, admittedHardlink?: boolean) => void;
}) {
  const { sourceDirectory, boundary, capturedRoot, managed, outputRoot, previous } = params;
  const from = previous ? pluginNativeNamespaceDirectory(previous) : sourceDirectory;
  const fromBoundary = previous ? pluginNativeNamespaceBoundary(previous) : boundary;
  const before = inspectDirectory(
    from,
    fromBoundary,
    previous ? undefined : outputRoot,
    !previous || Boolean(previous.referenceRoot),
    params.onDirectoryEntry,
  );
  const inspectedEntries = [...before.values()].map((member) => ({
    path: member.source,
    kind: member.stat.isDirectory() ? ("directory" as const) : ("file" as const),
  }));
  for (const root of params.inspectionRoots ?? [boundary]) {
    inspectedEntries.push({ path: root, kind: "directory" });
    for (const name of ["openclaw.plugin.json", "package.json"]) {
      const filename = path.join(root, name);
      if (fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
        inspectedEntries.push({ path: filename, kind: "file" });
      }
    }
  }
  const boundaryFiles = previous
    ? new Set<string>()
    : collectPluginSafetyInspectedFiles(inspectedEntries);
  for (const filename of params.inspectedFiles ?? []) {
    if (!previous) {
      boundaryFiles.add(fs.realpathSync(filename));
    }
  }
  const directory = path.join(capturedRoot, "content");
  const linkedSources = new Set<string>();
  const policyCheckedSources = new Set<string>();
  const checkSourcePolicy = (member: NamespaceMember, stat: fs.BigIntStats) => {
    const identity = pluginSourceStatIdentity(stat);
    if (
      identity !== member.identity &&
      (!linkedSources.has(member.source) ||
        !pluginSourceIdentityChangedOnlyByCtime(member.identity, identity))
    ) {
      throw new Error("Native plugin companion changed during admission");
    }
    params.onSourceDescriptor?.(member.source, stat);
    policyCheckedSources.add(member.source);
  };
  let referenceRoot: string | undefined;
  try {
    for (const [relative, member] of before) {
      const target = path.join(directory, relative);
      if (member.linkTo !== undefined) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.symlinkSync(
          path.relative(path.dirname(target), path.join(directory, member.linkTo)),
          target,
          "junction",
        );
      } else if (member.stat.isDirectory()) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      } else if (
        !params.copyManaged &&
        (previous ||
          (managed &&
            (params.managedRoots ?? [boundary]).some((root) =>
              isPathInside(root, member.source),
            ))) &&
        !(previous?.members[relative]?.boundaryChecked ?? boundaryFiles.has(member.source))
      ) {
        linkPluginSourceFile(member.source, member.boundary, target, (stat) =>
          checkSourcePolicy(member, stat),
        );
        linkedSources.add(member.source);
      } else {
        copyPluginSourceFile(member.source, member.boundary, target, {
          onSourceDescriptor: (stat) => checkSourcePolicy(member, stat),
        });
        fs.chmodSync(target, 0o600 | Number(member.stat.mode & 0o100n));
      }
    }
  } catch (error) {
    if (
      params.copyManaged ||
      !managed ||
      previous ||
      !params.retainedRoot ||
      [...before.values()].some((member) => !isPathInside(params.retainedRoot!, member.source)) ||
      !["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].some((code) =>
        hasErrnoCode(error, code),
      )
    ) {
      throw error;
    }
    for (const member of before.values()) {
      if (!member.stat.isFile() || policyCheckedSources.has(member.source)) {
        continue;
      }
      inspectPluginSourceDescriptor(member.source, member.boundary, (stat) =>
        checkSourcePolicy(member, stat),
      );
    }
    fs.rmSync(directory, { recursive: true, force: true });
    linkedSources.clear();
    fs.symlinkSync(sourceDirectory, directory, "junction");
    referenceRoot = params.retainedRoot;
  }
  const content = new Map<string, { contentHash?: string; sizeBytes: number }>();
  for (const [relative, member] of before) {
    if (!member.stat.isFile()) {
      continue;
    }
    if (!previous) {
      content.set(relative, { sizeBytes: Number(member.stat.size) });
      continue;
    }
    const filename = path.join(directory, relative);
    const stat = pluginSourceStatIdentity(fs.statSync(filename, { bigint: true }));
    const digest = hashPluginSourceFile(filename, capturedRoot);
    const prior = previous?.members[relative];
    if (
      stat !== pluginSourceStatIdentity(fs.statSync(filename, { bigint: true })) ||
      (prior && (digest.contentHash !== prior.contentHash || digest.sizeBytes !== prior.sizeBytes))
    ) {
      throw new Error("Native plugin companion changed during admission");
    }
    content.set(relative, digest);
  }
  const after = inspectDirectory(
    from,
    fromBoundary,
    previous ? undefined : outputRoot,
    !previous || Boolean(previous.referenceRoot),
    params.onDirectoryEntry,
  );
  const captured = inspectDirectory(
    referenceRoot ? sourceDirectory : directory,
    referenceRoot ?? capturedRoot,
    referenceRoot ? outputRoot : undefined,
    Boolean(referenceRoot),
    params.onDirectoryEntry,
  );
  if (
    before.size !== after.size ||
    captured.size !== before.size ||
    [...before].some(([relative, member]) => {
      const current = after.get(relative);
      return (
        !current ||
        current.source !== member.source ||
        (current.identity !== member.identity &&
          (!(managed || previous) ||
            !pluginSourceIdentityChangedOnlyByCtime(member.identity, current.identity)))
      );
    })
  ) {
    throw new Error("Native plugin directory changed during admission");
  }
  const changed = new Map<string, string>();
  const fact: PluginNativeNamespaceFact = {
    sourceDirectory,
    capturedRoot,
    managed,
    ...(referenceRoot ? { referenceRoot } : {}),
    members: Object.fromEntries(
      [...after].map(([relative, member]) => {
        // A successful link can share the filesystem's current ctime tick.
        if (
          linkedSources.has(member.source) &&
          member.identity === captured.get(relative)!.identity
        ) {
          changed.set(member.source, member.identity);
        }
        const old = previous?.members[relative];
        if (old) {
          old.capturedIdentity = member.identity;
        }
        const capturedPath = path.join(directory, relative);
        const admissionHardlinks = old
          ? old.admissionHardlinks && linkedSources.has(member.source)
            ? [...new Set([...old.admissionHardlinks, capturedPath])]
            : old.admissionHardlinks
          : linkedSources.has(member.source)
            ? [member.source, capturedPath]
            : undefined;
        return [
          relative,
          {
            source: old?.source ?? member.source,
            sourceIdentity: old?.sourceIdentity ?? member.identity,
            capturedIdentity: captured.get(relative)!.identity,
            boundaryChecked: old?.boundaryChecked ?? boundaryFiles.has(member.source),
            ...(admissionHardlinks ? { admissionHardlinks } : {}),
            ...content.get(relative),
          },
        ];
      }),
    ),
  };
  const admissionMembers = new Map<string, PluginNativeNamespaceFact["members"][string][]>();
  for (const member of Object.values(fact.members)) {
    if (!member.admissionHardlinks) {
      continue;
    }
    const stat = fs.statSync(member.source, { bigint: true, throwIfNoEntry: false });
    if (!stat?.isFile()) {
      continue;
    }
    const key = `${stat.dev}:${stat.ino}`;
    admissionMembers.set(key, [...(admissionMembers.get(key) ?? []), member]);
  }
  for (const members of admissionMembers.values()) {
    const inventory = [...new Set(members.flatMap((member) => member.admissionHardlinks ?? []))];
    for (const member of members) {
      member.admissionHardlinks = inventory;
    }
  }
  // A managed inode has both installed and retained names; linking either changes both identities.
  if (previous?.managed) {
    for (const [relative, member] of Object.entries(fact.members)) {
      const current = fs.statSync(member.source, { bigint: true, throwIfNoEntry: false });
      if (
        linkedSources.has(after.get(relative)!.source) &&
        current &&
        current.dev === after.get(relative)!.stat.dev &&
        current.ino === after.get(relative)!.stat.ino &&
        pluginSourceStatIdentity(current) === member.capturedIdentity
      ) {
        member.sourceIdentity = pluginSourceStatIdentity(current);
        previous.members[relative]!.sourceIdentity = member.sourceIdentity;
        changed.set(member.source, member.sourceIdentity);
      }
    }
  }
  return { fact, changed };
}

/** Recheck a reused namespace while distinguishing links created by its own admission. */
export function inspectPluginNativeNamespaceSources(
  namespace: PluginNativeNamespaceFact,
  inspect: (source: string, stat: fs.BigIntStats, admittedHardlink: boolean) => void,
): void {
  for (const member of Object.values(namespace.members)) {
    if (member.sizeBytes === undefined) {
      continue;
    }
    inspectPluginSourceDescriptor(member.source, path.dirname(member.source), (stat) =>
      inspect(member.source, stat, admittedPluginNativeHardlinks(member, stat) !== undefined),
    );
  }
}

function admittedPluginNativeHardlinks(
  member: PluginNativeNamespaceFact["members"][string],
  stat: fs.BigIntStats,
): string[] | undefined {
  if (!member.admissionHardlinks) {
    return undefined;
  }
  const inventory = () =>
    [...new Set(member.admissionHardlinks)].filter((filename) => {
      const candidate = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
      return candidate?.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino;
    });
  const live = inventory();
  const current = fs.lstatSync(member.source, { bigint: true, throwIfNoEntry: false });
  const verified = inventory();
  const finalSource = fs.lstatSync(member.source, { bigint: true, throwIfNoEntry: false });
  return current?.isFile() &&
    finalSource?.isFile() &&
    current.dev === stat.dev &&
    current.ino === stat.ino &&
    current.nlink === stat.nlink &&
    finalSource.dev === current.dev &&
    finalSource.ino === current.ino &&
    finalSource.nlink === current.nlink &&
    live.length === verified.length &&
    live.every((filename, index) => filename === verified[index]) &&
    BigInt(verified.length) === finalSource.nlink
    ? live
    : undefined;
}

export function pluginNativeNamespacesOwnSourceHardlinks(
  namespaces: Iterable<PluginNativeNamespaceFact>,
  source: string,
  stat: fs.BigIntStats,
): boolean {
  let member: PluginNativeNamespaceFact["members"][string] | undefined;
  const admissionHardlinks: string[] = [];
  for (const namespace of namespaces) {
    for (const candidate of Object.values(namespace.members)) {
      if (candidate.source === source && candidate.admissionHardlinks) {
        member ??= candidate;
        admissionHardlinks.push(...candidate.admissionHardlinks);
      }
    }
  }
  return Boolean(member && admittedPluginNativeHardlinks({ ...member, admissionHardlinks }, stat));
}

export function pluginNativeNamespaceUntrustedHardlinks(
  namespaces: Iterable<PluginNativeNamespaceFact>,
  admissionNamespaces: Iterable<PluginNativeNamespaceFact> = namespaces,
): Set<string> {
  const namespaceFacts = [...namespaces];
  const admissionFacts =
    admissionNamespaces === namespaces ? namespaceFacts : [...admissionNamespaces];
  const hardlinked = new Set<string>();
  for (const namespace of namespaceFacts) {
    inspectPluginNativeNamespaceSources(namespace, (source, stat, admitted) => {
      if (
        stat.nlink > 1n &&
        !admitted &&
        !pluginNativeNamespacesOwnSourceHardlinks(admissionFacts, source, stat)
      ) {
        hardlinked.add(source);
        for (const [relative, member] of Object.entries(namespace.members)) {
          if (member.source === source) {
            hardlinked.add(pluginNativeNamespaceMemberPath(namespace, relative));
          }
        }
      }
    });
  }
  return hardlinked;
}

/** Record another admission-owned name only while every existing link remains accounted for. */
export function trackPluginNativeNamespaceAdmissionLink(
  namespace: PluginNativeNamespaceFact,
  member: PluginNativeNamespaceFact["members"][string],
  target: string,
): () => void {
  const before = fs.statSync(member.source, { bigint: true });
  const admitted = admittedPluginNativeHardlinks(member, before);
  return () => {
    const after = fs.statSync(member.source, { bigint: true });
    if (
      admitted &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.nlink === before.nlink + 1n
    ) {
      const inventory = [...admitted, target];
      for (const candidate of Object.values(namespace.members)) {
        const stat = fs.statSync(candidate.source, { bigint: true, throwIfNoEntry: false });
        if (
          candidate.admissionHardlinks &&
          stat?.isFile() &&
          stat.dev === after.dev &&
          stat.ino === after.ino
        ) {
          candidate.admissionHardlinks = inventory;
        }
      }
    }
  };
}

/** Fill dormant companion digests after the legacy initial receipt has consumed native bytes. */
export function finishPluginNativeNamespace(fact: PluginNativeNamespaceFact): void {
  for (const [relative, member] of Object.entries(fact.members)) {
    if (member.sizeBytes === undefined || member.contentHash) {
      continue;
    }
    const filename = pluginNativeNamespaceMemberPath(fact, relative);
    const content = hashPluginSourceFile(filename, pluginNativeNamespaceBoundary(fact));
    if (
      content.sizeBytes !== member.sizeBytes ||
      pluginSourceStatIdentity(fs.statSync(filename, { bigint: true })) !== member.capturedIdentity
    ) {
      throw new Error("Native plugin companion changed before admission completed");
    }
    member.contentHash = content.contentHash;
  }
}
