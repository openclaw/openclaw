import fs from "node:fs";
import path from "node:path";
import { createRootFileOpenBatchSync } from "@openclaw/fs-safe/advanced";
import { isPathInside } from "../infra/path-guards.js";
import { SQLITE_STAGING_TOKEN_FILES } from "../infra/sqlite-staging-token.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import { hashPluginSourceFile, pluginSourceStatIdentity } from "./plugin-source-file.js";
import { resolvePluginSnapshotLink } from "./plugin-source-snapshot-payload.js";
import type {
  PluginSourceSnapshotBinding,
  PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

export const ownerIdentity = (stat: fs.BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${stat.mode}`;

export type PluginSourceSnapshotEntry = { path: string; identity: string; owner?: string } & (
  | { kind: "directory" }
  | { kind: "file"; contentHash: string; sizeBytes: number; mode: number; sourceMode?: number }
  | { kind: "link"; target: string }
);
type Entry = PluginSourceSnapshotEntry;
export type PluginSourceSnapshotManifest = PluginSourceSnapshotBinding & {
  formatVersion: number;
  generation: string;
  sourceRoot: string;
  root: string;
  aliases: Record<string, string>;
  sourceDigest: string;
  payloadIdentity: string;
  tokenIdentity: string;
  hardlinks: string[];
  platform: string;
  arch: string;
  abi: string;
  entries: Entry[];
  resolution?: Record<string, string>;
  configuration?: Record<string, string>;
};
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

export function fail(root: string, detail: string): never {
  throw new PluginSourceSnapshotValidationError(root, detail);
}

export function tokenIdentity(root: string): string {
  const tokenPath = path.join(root, SQLITE_STAGING_TOKEN_FILES[0]);
  const stat = fs.lstatSync(tokenPath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n)
  ) {
    fail(root, `unsafe token ownership or permissions: ${tokenPath}`);
  }
  return ownerIdentity(stat);
}

export function privateEntry(file: string, root: string, kind: "directory" | "file" | "link") {
  const stat = fs.lstatSync(file, { bigint: true });
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
    fail(root, `unsafe ${kind} ownership, permissions or identity: ${file}`);
  }
  return stat;
}

export function relativeMember(root: string, member: string): string {
  const relative = path.relative(root, member);
  if (!relative || !isPathInside(root, member)) {
    fail(root, `member leaves its payload: ${member}`);
  }
  return relative;
}

export function scanPayload(
  root: string,
  opened: ReturnType<typeof createRootFileOpenBatchSync>,
  publishedPayload = root,
): Entry[] {
  const entries: Entry[] = [];
  const visit = (directory: string) => {
    const before = privateEntry(directory, root, "directory");
    for (const name of fs.readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const relative = relativeMember(root, file);
      if (stat.isSymbolicLink()) {
        privateEntry(file, root, "link");
        const target = resolvePluginSnapshotLink(root, file, publishedPayload, (detail) =>
          fail(root, detail),
        );
        if (
          pluginSourceStatIdentity(stat) !==
          pluginSourceStatIdentity(privateEntry(file, root, "link"))
        ) {
          fail(root, `dependency link changed while validating: ${file}`);
        }
        entries.push({
          path: relative,
          kind: "link",
          target: relativeMember(root, target),
          identity: pluginSourceStatIdentity(stat),
        });
      } else if (stat.isDirectory()) {
        privateEntry(file, root, "directory");
        entries.push({
          path: relative,
          kind: "directory",
          identity: pluginSourceStatIdentity(stat),
        });
        visit(file);
      } else {
        privateEntry(file, root, "file");
        const content = hashPluginSourceFile(
          file,
          root,
          undefined,
          undefined,
          opened.openFile.bind(opened),
        );
        const after = privateEntry(file, root, "file");
        if (pluginSourceStatIdentity(stat) !== pluginSourceStatIdentity(after)) {
          fail(root, `file changed while validating: ${file}`);
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
      pluginSourceStatIdentity(privateEntry(directory, root, "directory"))
    ) {
      fail(root, `directory changed while validating: ${directory}`);
    }
  };
  visit(root);
  return entries;
}

export class PluginSourceSnapshotIncompatibleError extends Error {
  readonly code = "PLUGIN_SOURCE_SNAPSHOT_INCOMPATIBLE";
  constructor(
    readonly artifactPath: string,
    readonly formatVersion: number,
  ) {
    super(`Plugin source snapshot format ${formatVersion} at ${artifactPath} needs republication`);
    this.name = "PluginSourceSnapshotIncompatibleError";
  }
}

export type SnapshotStagingParameters = {
  stateDir: string;
  capture: PluginGenerationArtifact;
  binding: PluginSourceSnapshotBinding;
  assertCurrent: () => void | Promise<void>;
};
export type SnapshotAcquisitionParameters = {
  stateDir: string;
  descriptor: PluginSourceSnapshotDescriptor;
  assertCurrent: () => void | Promise<void>;
};
