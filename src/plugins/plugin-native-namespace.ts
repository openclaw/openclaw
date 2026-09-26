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
): void {
  if (!fact.referenceRoot) {
    return;
  }
  for (const directory of createRequire(
    path.join(fact.sourceDirectory, "native-host.cjs"),
  ).resolve.paths("openclaw") ?? []) {
    const candidate = path.join(directory, "openclaw");
    if (!isPathInside(fact.referenceRoot, candidate) || !fs.existsSync(candidate)) {
      continue;
    }
    if (fs.realpathSync(candidate) === hostRoot) {
      return;
    }
    break;
  }
  throw new Error(
    "Retained native directory does not resolve the selected OpenClaw host; repair the installed plugin's OpenClaw peer link before loading it.",
  );
}

function inspectDirectory(
  directory: string,
  boundary: string,
  outputRoot?: string,
  sourceDependencies = true,
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
      for (const name of fs.readdirSync(source).toSorted()) {
        if (name !== ".git" && name !== "node_modules") {
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
          capturePluginDependencies({
            root,
            manifestFile,
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
        for (const name of fs.existsSync(modules) ? fs.readdirSync(modules).toSorted() : []) {
          const names = name.startsWith("@")
            ? fs
                .readdirSync(path.join(modules, name))
                .toSorted()
                .map((entry) => `${name}/${entry}`)
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
): boolean {
  const source = inspectDirectory(fact.sourceDirectory, boundary, outputRoot);
  const captured = inspectDirectory(
    pluginNativeNamespaceDirectory(fact),
    pluginNativeNamespaceBoundary(fact),
    fact.referenceRoot ? outputRoot : undefined,
    Boolean(fact.referenceRoot),
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
  outputRoot?: string;
  previous?: PluginNativeNamespaceFact;
  inspectionRoots?: readonly string[];
  inspectedFiles?: readonly string[];
  retainedRoot?: string;
  managedRoots?: readonly string[];
}) {
  const { sourceDirectory, boundary, capturedRoot, managed, outputRoot, previous } = params;
  const from = previous ? pluginNativeNamespaceDirectory(previous) : sourceDirectory;
  const fromBoundary = previous ? pluginNativeNamespaceBoundary(previous) : boundary;
  const before = inspectDirectory(
    from,
    fromBoundary,
    previous ? undefined : outputRoot,
    !previous || Boolean(previous.referenceRoot),
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
        (previous ||
          (managed &&
            (params.managedRoots ?? [boundary]).some((root) =>
              isPathInside(root, member.source),
            ))) &&
        !(previous?.members[relative]?.boundaryChecked ?? boundaryFiles.has(member.source))
      ) {
        linkPluginSourceFile(member.source, member.boundary, target);
      } else {
        copyPluginSourceFile(member.source, member.boundary, target);
        fs.chmodSync(target, 0o600 | Number(member.stat.mode & 0o100n));
      }
    }
  } catch (error) {
    if (
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
    fs.rmSync(directory, { recursive: true, force: true });
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
  );
  const captured = inspectDirectory(
    referenceRoot ? sourceDirectory : directory,
    referenceRoot ?? capturedRoot,
    referenceRoot ? outputRoot : undefined,
    Boolean(referenceRoot),
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
        if (member.identity !== before.get(relative)!.identity) {
          changed.set(member.source, member.identity);
        }
        const old = previous?.members[relative];
        if (old) {
          old.capturedIdentity = member.identity;
        }
        return [
          relative,
          {
            source: old?.source ?? member.source,
            sourceIdentity: old?.sourceIdentity ?? member.identity,
            capturedIdentity: captured.get(relative)!.identity,
            boundaryChecked: old?.boundaryChecked ?? boundaryFiles.has(member.source),
            ...content.get(relative),
          },
        ];
      }),
    ),
  };
  // A managed inode has both installed and retained names; linking either changes both identities.
  if (previous?.managed) {
    for (const [relative, member] of Object.entries(fact.members)) {
      const current = fs.statSync(member.source, { bigint: true, throwIfNoEntry: false });
      if (
        current &&
        current.dev === after.get(relative)!.stat.dev &&
        current.ino === after.get(relative)!.stat.ino
      ) {
        member.sourceIdentity = pluginSourceStatIdentity(current);
        previous.members[relative]!.sourceIdentity = member.sourceIdentity;
        changed.set(member.source, member.sourceIdentity);
      }
    }
  }
  return { fact, changed };
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
