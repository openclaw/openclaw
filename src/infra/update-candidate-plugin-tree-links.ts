import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hashFileMutationSnapshotSync, sameFileMutationMetadata } from "./file-descriptor.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { ignoreMissingUpdateCandidateFile } from "./update-candidate-files.js";
import {
  captureUpdateCandidatePluginCodeLink,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";
import { runUpdateCandidatePluginTasks } from "./update-candidate-plugin-tasks.js";
import type {
  UpdateCandidatePluginEntry,
  UpdateCandidatePluginTreePlan,
} from "./update-candidate-plugin-tree-schema.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

type MaterializablePlan = Omit<UpdateCandidatePluginTreePlan, "bytes" | "entries">;

export function ignoreUnresolvedPluginLink(error: unknown): undefined {
  if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
    return undefined;
  }
  throw error;
}

export const isUpdateCandidateHostLauncher = (file: string) =>
  path.basename(path.dirname(file)) === ".bin" &&
  ["openclaw", "openclaw.cmd", "openclaw.ps1"].includes(path.basename(file));

export function assertUpdateCandidatePluginEntryStat(
  entry: UpdateCandidatePluginEntry,
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
  if (entry.kind === "file") {
    const expected = {
      dev: BigInt(entry.dev),
      ino: BigInt(entry.ino),
      size: BigInt(entry.size),
      birthtimeNs: BigInt(entry.birthtimeNs),
      mtimeNs: BigInt(entry.mtimeNs),
      ctimeNs: BigInt(entry.ctimeNs),
      mode: BigInt(entry.mode | constants.S_IFREG),
      uid: BigInt(entry.uid),
      gid: BigInt(entry.gid),
    };
    if (
      !sameFileMutationMetadata(expected, current) ||
      (current.ctimeNs !== expected.ctimeNs &&
        hashFileMutationSnapshotSync(entry.path, expected) !== entry.sha256)
    ) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
  } else if (entry.kind === "symlink" && current.size !== BigInt(entry.size)) {
    throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
  }
}

/** Rebase the admitted plan onto the caller's state directory and check its bindings still hold. */
export function resolveUpdateCandidatePluginTreeTargets(
  plan: MaterializablePlan,
  params: { targetStateDir: string; candidateRoot: string },
  onProgress?: () => void,
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
    await runUpdateCandidatePluginTasks([
      ...plan.moduleBindings.map(([source, real]) => async () => {
        if ((await fs.realpath(source)) !== real) {
          throw new Error(`Plugin module owner changed after snapshot inventory: ${source}`);
        }
        onProgress?.();
      }),
      ...plan.edges.map((edge) => async () => {
        const target = path.resolve(path.dirname(edge.source), await fs.readlink(edge.source));
        const real = await fs
          .realpath(edge.source)
          .catch((error: unknown) => ignoreUnresolvedPluginLink(error) ?? target);
        if (target !== edge.target || real !== edge.real) {
          throw new Error(`Plugin link changed after snapshot inventory: ${edge.source}`);
        }
        onProgress?.();
      }),
    ]);
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
  // Projection owns these private links; host edges and private aliases retain
  // their distinct admission order and existing-target checks.
  const publish = async (file: string, target: string, kind: "host link" | "module alias") => {
    const host = kind === "host link";
    const parent = path.dirname(file);
    if (!isPathInside(privateRoot, resolvePathViaExistingAncestorSync(parent))) {
      throw new Error(`Plugin ${kind} escapes update state`);
    }
    if (host) {
      params.assertBeforeMutation?.();
      await fs.mkdir(parent, { recursive: true });
    }
    const existing = await fs.lstat(file).catch(ignoreMissingUpdateCandidateFile);
    if (existing) {
      const matches = host
        ? existing.isSymbolicLink() && path.resolve(parent, await fs.readlink(file)) === target
        : (await fs.realpath(file)) === (await fs.realpath(target));
      if (!matches) {
        throw new Error(`Plugin ${kind} conflicts with its ${host ? "update" : "private"} owner`);
      }
    } else {
      if (!host) {
        params.assertBeforeMutation?.();
        await fs.mkdir(parent, { recursive: true });
      }
      params.assertBeforeMutation?.();
      await fs.symlink(target, file, process.platform === "win32" ? "junction" : "dir");
    }
  };
  for (const link of params.hostLinks) {
    await publish(link, candidateRoot, "host link");
  }
  const privateAliases: string[] = [];
  for (const [alias, target] of params.aliases) {
    await publish(alias, target, "module alias");
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
  rootFile: string,
  params: {
    privateRoot: string;
    candidateRoot: string;
    hostLinks: Set<string>;
    onCodeLink?: (fact: UpdateCandidatePluginCodeLink) => void;
    onProgress?: () => void;
  },
): Promise<void> {
  const readEntry = async (file: string) => {
    const stat = await fs.lstat(file, { bigint: true });
    const link = stat.isSymbolicLink() ? await fs.readlink(file) : undefined;
    return { file, stat, link };
  };
  const verify = async ({
    file,
    stat,
    link,
  }: Awaited<ReturnType<typeof readEntry>>): Promise<void> => {
    if (params.hostLinks.has(file)) {
      if (
        !stat.isSymbolicLink() ||
        path.resolve(path.dirname(file), link!) !== params.candidateRoot
      ) {
        throw new Error("Copied plugin host link does not target the update");
      }
    } else if (stat.isSymbolicLink()) {
      assertUpdateCandidatePluginLinkTarget(file, path.resolve(path.dirname(file), link!), params);
    }
    params.onProgress?.();
    // Inspect the entry before traversal, including standalone module aliases;
    // following a copied root link can otherwise accept an entirely live tree.
    if (link !== undefined) {
      params.onCodeLink?.(captureUpdateCandidatePluginCodeLink(file, stat, link));
      return;
    }
    if (stat.isDirectory()) {
      const listing = await fs.readdir(file, { withFileTypes: true });
      const leaves = await runUpdateCandidatePluginTasks(
        listing
          .filter((entry) => !entry.isDirectory())
          .map((entry) => () => readEntry(path.join(file, entry.name))),
      );
      const observations = new Map(leaves.map((entry) => [entry.file, entry]));
      for (const entry of listing) {
        const child = path.join(file, entry.name);
        await verify(entry.isDirectory() ? await readEntry(child) : observations.get(child)!);
      }
    }
  };
  await verify(await readEntry(rootFile));
}
