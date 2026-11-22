import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { createRootFileOpenBatchSync } from "@openclaw/fs-safe/advanced";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import { linkPluginGenerationDependency } from "./plugin-generation-file-capture.js";
import {
  copyPluginSourceFile,
  hashPluginSourceFile,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";

type Invalid = (detail: string) => never;

export type PluginSnapshotPayloadEntry = { path: string; identity: string } & (
  | { kind: "directory" }
  | { kind: "file"; contentHash: string; sizeBytes: number; mode: number }
  | { kind: "link"; target: string }
);
export class PluginSourceSnapshotValidationError extends Error {
  readonly code = "PLUGIN_SOURCE_SNAPSHOT_INVALID";
  constructor(
    readonly artifactPath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Installed plugin source snapshot is invalid at ${artifactPath}: ${detail}`, options);
    this.name = "PluginSourceSnapshotValidationError";
  }
}

export function failPluginSourceSnapshot(root: string, detail: string): never {
  throw new PluginSourceSnapshotValidationError(root, detail);
}

export function privatePluginSnapshotEntry(
  file: string,
  root: string,
  kind: "directory" | "file" | "link",
) {
  return assertPrivatePluginSnapshotEntry(file, root, kind, fs.lstatSync(file, { bigint: true }));
}

export function assertPrivatePluginSnapshotEntry(
  file: string,
  root: string,
  kind: "directory" | "file" | "link",
  stat: fs.BigIntStats,
) {
  if (
    !(kind === "directory"
      ? stat.isDirectory()
      : kind === "file"
        ? stat.isFile()
        : stat.isSymbolicLink()) ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (kind !== "link" && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) ||
    (kind === "file" && stat.nlink !== 1n) ||
    (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
  ) {
    failPluginSourceSnapshot(root, `unsafe ${kind} ownership, permissions or identity: ${file}`);
  }
  return stat;
}

export function relativePluginSnapshotMember(root: string, member: string): string {
  const relative = path.relative(root, member);
  if (!relative || !isPathInside(root, member)) {
    failPluginSourceSnapshot(root, `member leaves its payload: ${member}`);
  }
  return relative;
}

export function scanPluginSnapshotPayload(
  root: string,
  opened: ReturnType<typeof createRootFileOpenBatchSync>,
  publishedPayload = root,
): PluginSnapshotPayloadEntry[] {
  const entries: PluginSnapshotPayloadEntry[] = [];
  const visit = (directory: string) => {
    const before = privatePluginSnapshotEntry(directory, root, "directory");
    for (const name of fs.readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const relative = relativePluginSnapshotMember(root, file);
      if (stat.isSymbolicLink()) {
        privatePluginSnapshotEntry(file, root, "link");
        const target = resolvePluginSnapshotLink(root, file, publishedPayload, (detail) =>
          failPluginSourceSnapshot(root, detail),
        );
        if (
          pluginSourceStatIdentity(stat) !==
          pluginSourceStatIdentity(privatePluginSnapshotEntry(file, root, "link"))
        ) {
          failPluginSourceSnapshot(root, `dependency link changed while validating: ${file}`);
        }
        entries.push({
          path: relative,
          kind: "link",
          target: relativePluginSnapshotMember(root, target),
          identity: pluginSourceStatIdentity(stat),
        });
      } else if (stat.isDirectory()) {
        privatePluginSnapshotEntry(file, root, "directory");
        entries.push({
          path: relative,
          kind: "directory",
          identity: pluginSourceStatIdentity(stat),
        });
        visit(file);
      } else {
        privatePluginSnapshotEntry(file, root, "file");
        const content = hashPluginSourceFile(
          file,
          root,
          undefined,
          undefined,
          opened.openFile.bind(opened),
        );
        const after = privatePluginSnapshotEntry(file, root, "file");
        if (pluginSourceStatIdentity(stat) !== pluginSourceStatIdentity(after)) {
          failPluginSourceSnapshot(root, `file changed while validating: ${file}`);
        }
        entries.push({
          path: relative,
          kind: "file",
          identity: pluginSourceStatIdentity(after),
          ...content,
          mode: Number(after.mode & 0o777n),
        });
      }
    }
    if (
      pluginSourceStatIdentity(before) !==
      pluginSourceStatIdentity(privatePluginSnapshotEntry(directory, root, "directory"))
    ) {
      failPluginSourceSnapshot(root, `directory changed while validating: ${directory}`);
    }
  };
  visit(root);
  return entries;
}

/** Junctions name the final namespace before the complete artifact is renamed into it. */
export function capturePluginSnapshotPayload(
  capture: PluginGenerationArtifact,
  payload: string,
  publishedPayload: string,
  invalid: Invalid,
) {
  const links: Array<[string, string]> = [];
  const copy = (source: string, target: string) => {
    const stat = fs.lstatSync(source, { bigint: true });
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(source), fs.readlinkSync(source));
      if (!isPathInside(capture.boundaryRoot, resolved)) {
        invalid(`capture contains an external link: ${source}`);
      }
      links.push([target, path.join(payload, path.relative(capture.boundaryRoot, resolved))]);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(source).toSorted()) {
        copy(path.join(source, name), path.join(target, name));
      }
    } else if (stat.isFile()) {
      copyPluginSourceFile(source, capture.boundaryRoot, target);
    } else {
      invalid(`capture contains a nonregular source: ${source}`);
    }
  };
  copy(capture.boundaryRoot, payload);
  for (const [link, target] of links) {
    linkPluginGenerationDependency(
      link,
      path.join(publishedPayload, path.relative(payload, target)),
      target,
    );
  }
}

export function resolvePluginSnapshotLink(
  payload: string,
  file: string,
  publishedPayload: string,
  invalid: Invalid,
): string {
  const observed = path.resolve(path.dirname(file), fs.readlinkSync(file));
  const target =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(observed) : observed;
  const physical = path.resolve(payload, path.relative(publishedPayload, target));
  // Captured dependency aliases point to materialized package directories, never other links.
  if (
    !isPathInside(publishedPayload, target) ||
    !isPathInside(payload, physical) ||
    !fs.lstatSync(physical).isDirectory() ||
    !isPathInside(payload, fs.realpathSync(physical))
  ) {
    invalid(`dependency link leaves its frozen closure: ${file}`);
  }
  return physical;
}

/** Logical closure facts exclude ephemeral capture paths and inode identities. */
export function digestPluginSnapshotClosure(
  capture: PluginGenerationArtifact,
  invalid: Invalid,
): string {
  const facts = capture.sourceSnapshotFacts;
  if (!facts) {
    invalid("capture does not own complete source facts");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        aliases: Object.entries(capture.sourceAliases)
          .map(([source, captured]) => [source, path.relative(capture.boundaryRoot, captured)])
          .toSorted(([left], [right]) => left!.localeCompare(right!)),
        directories: [...facts.directories].toSorted(),
        links: [...facts.links].toSorted(([left], [right]) => left.localeCompare(right)),
        files: [...facts.files]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([file, fact]) => [file, fact.contentHash, fact.sizeBytes, fact.mode]),
        hardlinks: [...facts.hardlinks].toSorted(),
      }),
    )
    .digest("hex");
}
