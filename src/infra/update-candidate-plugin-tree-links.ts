import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  captureUpdateCandidatePluginCodeLink,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";
import type { UpdateCandidatePluginTreePlan } from "./update-candidate-plugin-tree.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

export type UpdateCandidatePluginTreeEntry = UpdateCandidatePluginTreePlan["entries"][number];

type MaterializablePlan = Omit<UpdateCandidatePluginTreePlan, "bytes" | "entries">;

export const isUpdateCandidateHostLauncher = (file: string) =>
  path.basename(path.dirname(file)) === ".bin" &&
  ["openclaw", "openclaw.cmd", "openclaw.ps1"].includes(path.basename(file));

export function assertUpdateCandidatePluginEntryStat(
  entry: UpdateCandidatePluginTreeEntry,
  current: BigIntStats,
): void {
  const sameKind =
    entry.kind === "directory"
      ? current.isDirectory()
      : entry.kind === "file"
        ? current.isFile()
        : current.isSymbolicLink();
  const sameIdentity = current.dev.toString() === entry.dev && current.ino.toString() === entry.ino;
  const sameMode = Number(current.mode & 0o7777n) === entry.mode;
  if (!sameKind || !sameIdentity || !sameMode) {
    throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
  }
  const sameFile =
    entry.kind !== "file" ||
    sameFileMutationFingerprint(current, {
      dev: BigInt(entry.dev),
      ino: BigInt(entry.ino),
      size: BigInt(entry.size),
      birthtimeNs: BigInt(entry.birthtimeNs),
      mtimeNs: BigInt(entry.mtimeNs),
      ctimeNs: BigInt(entry.ctimeNs),
    });
  if (!sameFile || (entry.kind === "symlink" && current.size !== BigInt(entry.size))) {
    throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
  }
}

/** Rebase the admitted plan onto the caller's state directory and check its bindings still hold. */
export function resolveUpdateCandidatePluginTreeTargets(
  plan: MaterializablePlan,
  params: { targetStateDir: string; candidateRoot: string },
) {
  const privateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const candidateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.candidateRoot));
  if (candidateRoot !== plan.candidateRoot) {
    throw new Error("Plugin files changed during update preparation; rerun the update");
  }
  const rebasing = prepareRuntimeRelocations([
    { sourceRoot: plan.privateRoot, destinationRoot: privateRoot },
  ]);
  const rebase = (file: string) => relocateRuntimePath(file, rebasing);
  const copies = plan.copies.map<[string, string]>(([source, target]) => [source, rebase(target)]);
  for (const [, target] of copies) {
    const destination = resolvePathViaExistingAncestorSync(target);
    if (!isPathInside(privateRoot, destination)) {
      throw new Error("Plugin copy destination escapes update state");
    }
    for (const [other] of copies) {
      if (isPathInside(other, destination) || isPathInside(destination, other)) {
        throw new Error("Plugin copy source overlaps its destination");
      }
    }
  }
  const copyOwner = createRuntimePathLookup(copies.map((copy) => [copy[0], copy] as const));
  const destinationFor = (source: string) => {
    const owner = copyOwner(source);
    if (!owner) {
      throw new Error("Inventoried plugin entry has no copy owner");
    }
    return path.join(owner[1], path.relative(owner[0], source));
  };
  const assertBindings = async () => {
    for (const [source, real] of plan.moduleBindings) {
      if ((await fs.realpath(source)) !== real) {
        throw new Error(`Plugin module owner changed after snapshot inventory: ${source}`);
      }
    }
    for (const edge of plan.edges) {
      const target = path.resolve(path.dirname(edge.source), await fs.readlink(edge.source));
      const real = await fs.realpath(edge.source).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
          return target;
        }
        throw error;
      });
      if (target !== edge.target || real !== edge.real) {
        throw new Error(`Plugin link changed after snapshot inventory: ${edge.source}`);
      }
    }
  };
  return {
    privateRoot,
    candidateRoot,
    copies,
    hostLinks: new Set(plan.hostLinks.map(rebase)),
    relocations: prepareRuntimeRelocations(
      plan.relocations.map(({ sourceRoot, destinationRoot }) => ({
        sourceRoot,
        destinationRoot: rebase(destinationRoot),
      })),
    ),
    aliases: plan.aliases.map<[string, string]>(([alias, target]) => [
      rebase(alias),
      rebase(target),
    ]),
    destinationFor,
    assertBindings,
  };
}

/** Publish host links and module aliases; both must stay inside the private tree. */
export async function publishUpdateCandidatePluginTreeLinks(params: {
  privateRoot: string;
  candidateRoot: string;
  hostLinks: Set<string>;
  aliases: Array<[string, string]>;
  assertBeforeMutation?: () => void;
}): Promise<string[]> {
  const { privateRoot, candidateRoot } = params;
  // Projection owns these private links. Installer peer-link policy expects a
  // literal node_modules directory and cannot bind a relocated module owner.
  for (const link of params.hostLinks) {
    if (!isPathInside(privateRoot, resolvePathViaExistingAncestorSync(path.dirname(link)))) {
      throw new Error("Plugin host link escapes update state");
    }
    params.assertBeforeMutation?.();
    await fs.mkdir(path.dirname(link), { recursive: true });
    const existing = await fs.lstat(link).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      if (
        !existing.isSymbolicLink() ||
        path.resolve(path.dirname(link), await fs.readlink(link)) !== candidateRoot
      ) {
        throw new Error("Plugin host link conflicts with its update owner");
      }
    } else {
      params.assertBeforeMutation?.();
      await fs.symlink(candidateRoot, link, process.platform === "win32" ? "junction" : "dir");
    }
  }
  const privateAliases: string[] = [];
  for (const [alias, target] of params.aliases) {
    if (!isPathInside(privateRoot, resolvePathViaExistingAncestorSync(path.dirname(alias)))) {
      throw new Error("Plugin module alias escapes update state");
    }
    const existing = await fs.lstat(alias).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      if ((await fs.realpath(alias)) !== (await fs.realpath(target))) {
        throw new Error("Plugin module alias conflicts with its private owner");
      }
    } else {
      params.assertBeforeMutation?.();
      await fs.mkdir(path.dirname(alias), { recursive: true });
      params.assertBeforeMutation?.();
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    }
    privateAliases.push(alias);
  }
  return privateAliases;
}

/** Symbolic links in the private tree may only point back into it or at the update host. */
export function assertUpdateCandidatePluginLinkTarget(
  file: string,
  target: string,
  params: { privateRoot: string; candidateRoot: string },
): void {
  if (
    !isPathInside(params.privateRoot, target) &&
    !(isUpdateCandidateHostLauncher(file) && isPathInside(params.candidateRoot, target))
  ) {
    throw new Error("Copied plugin symlink escapes update state");
  }
}

export async function verifyUpdateCandidatePluginTree(
  file: string,
  params: {
    privateRoot: string;
    candidateRoot: string;
    hostLinks: Set<string>;
    onCodeLink?: (fact: UpdateCandidatePluginCodeLink) => void;
  },
): Promise<void> {
  const stat = await fs.lstat(file, { bigint: true });
  const link = stat.isSymbolicLink() ? await fs.readlink(file) : undefined;
  if (params.hostLinks.has(file)) {
    if (
      !stat.isSymbolicLink() ||
      path.resolve(path.dirname(file), link!) !== params.candidateRoot
    ) {
      throw new Error("Copied plugin host link does not target the update");
    }
    params.onCodeLink?.(captureUpdateCandidatePluginCodeLink(file, stat, link!));
    return;
  }
  // Inspect the entry before traversal, including standalone module aliases;
  // following a copied root link can otherwise accept an entirely live tree.
  if (stat.isSymbolicLink()) {
    assertUpdateCandidatePluginLinkTarget(file, path.resolve(path.dirname(file), link!), params);
    params.onCodeLink?.(captureUpdateCandidatePluginCodeLink(file, stat, link!));
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(file)) {
      await verifyUpdateCandidatePluginTree(path.join(file, entry), params);
    }
  }
}
