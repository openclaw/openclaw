import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import { sha256Hex } from "./crypto-digest.js";
import { isPathInside } from "./path-guards.js";
import { resolveUpdateCandidatePluginSourcePath } from "./update-candidate-paths.js";
import {
  assertUpdateCandidatePluginCodeLink,
  sealUpdateCandidatePluginCodeLinks,
  UpdateCandidatePluginCodeLinkSchema,
  UpdateCandidatePluginCodeLinkReceiptSchema,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";

export const UPDATE_PLUGIN_ASSET_RECEIPT_ENV = "OPENCLAW_UPDATE_PLUGIN_ASSET_RECEIPT";
const inventoryName = ".update-plugin-assets.json";
type AssetEdge = UpdateCandidatePluginCodeLink & {
  asset: NonNullable<UpdateCandidatePluginCodeLink["asset"]>;
  target: NonNullable<UpdateCandidatePluginCodeLink["target"]>;
};

function identity(stat: fs.BigIntStats) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function assertPhysicalPath(root: string, file: string): void {
  if (path.resolve(root) !== root || path.resolve(file) !== file || !isPathInside(root, file)) {
    throw new Error("Private plugin asset leaves its copied root");
  }
  const uid = process.getuid?.();
  let current = root;
  for (const relative of [
    "",
    ...path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean),
  ]) {
    // Walk incrementally; realpath equality alone does not reject an intermediate alias.
    current = path.join(current, relative);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("Private plugin asset has an unsafe parent");
    }
  }
}

/** Only namespaces allocated by the updater plugin projector, never general copied state. */
export function isUpdateCandidatePluginAssetPath(stateDir: string, filename: string): boolean {
  return (
    ["npm", "extensions"].some((name) => isPathInside(path.join(stateDir, name), filename)) ||
    resolveUpdateCandidatePluginSourcePath(stateDir, filename) !== undefined
  );
}

function withTarget<T>(edge: AssetEdge, read: (fd: number) => T): T {
  const { root } = edge.asset;
  if (
    !isUpdateCandidatePluginAssetPath(root.path, edge.path) ||
    !isUpdateCandidatePluginAssetPath(root.path, edge.target.path)
  ) {
    throw new Error("Private plugin asset is not a projected plugin file");
  }
  const stat = fs.lstatSync(root.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(root.path) !== root.path ||
    identity(stat).dev !== root.dev ||
    identity(stat).ino !== root.ino ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error("Private plugin asset root changed");
  }
  assertPhysicalPath(root.path, edge.path);
  assertPhysicalPath(root.path, edge.target.path);
  assertUpdateCandidatePluginCodeLink(edge);
  const opened = openRootFileSync({
    absolutePath: edge.target.path,
    rootPath: root.path,
    boundaryLabel: "verified private plugin asset",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new Error("Cannot open verified private plugin asset", { cause: opened.error });
  }
  try {
    const target = fs.fstatSync(opened.fd, { bigint: true });
    if (
      !target.isFile() ||
      target.nlink !== 1n ||
      identity(target).dev !== edge.target.dev ||
      identity(target).ino !== edge.target.ino ||
      Number(target.size) !== edge.asset.bytes ||
      (process.getuid && target.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Private plugin asset target changed");
    }
    const value = read(opened.fd);
    const after = fs.fstatSync(opened.fd, { bigint: true });
    if (
      after.nlink !== 1n ||
      target.size !== after.size ||
      target.mtimeNs !== after.mtimeNs ||
      target.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Private plugin asset changed during acquisition");
    }
    assertUpdateCandidatePluginCodeLink(edge);
    assertPhysicalPath(root.path, edge.target.path);
    const currentRoot = fs.lstatSync(root.path, { bigint: true });
    if (
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink() ||
      identity(currentRoot).dev !== root.dev ||
      identity(currentRoot).ino !== root.ino ||
      (process.platform !== "win32" && (currentRoot.mode & 0o077n) !== 0n)
    ) {
      throw new Error("Private plugin asset root changed during acquisition");
    }
    return value;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function digest(fd: number, bytes: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (!length) {
      throw new Error("Private plugin asset was truncated");
    }
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  return hash.digest("hex");
}

/** Called only after the tree planner has projected and verified this exact edge. */
export function captureUpdateCandidatePluginAsset(
  fact: UpdateCandidatePluginCodeLink,
  privateRoot: string,
): UpdateCandidatePluginCodeLink {
  if (
    !fact.target ||
    !isUpdateCandidatePluginAssetPath(privateRoot, fact.path) ||
    !isUpdateCandidatePluginAssetPath(privateRoot, fact.target.path)
  ) {
    return fact;
  }
  const stat = fs.lstatSync(fact.target.path, { bigint: true });
  if (!stat.isFile()) {
    return fact;
  } // Directory links never confer asset authority.
  const edge: AssetEdge = {
    ...fact,
    target: fact.target,
    asset: {
      root: { path: privateRoot, ...identity(fs.lstatSync(privateRoot, { bigint: true })) },
      bytes: Number(stat.size),
      sha256: "0".repeat(64),
    },
  };
  if (!Number.isSafeInteger(edge.asset.bytes)) {
    throw new Error("Private plugin asset is too large");
  }
  edge.asset.sha256 = withTarget(edge, (fd) => digest(fd, edge.asset.bytes));
  return edge;
}

export function assertUpdateCandidatePluginAsset(
  edge: UpdateCandidatePluginCodeLink,
): asserts edge is AssetEdge {
  if (!edge.asset || !edge.target) {
    throw new Error("Unverified private plugin asset edge");
  }
  const hash = withTarget(edge as AssetEdge, (fd) => digest(fd, edge.asset!.bytes));
  if (hash !== edge.asset.sha256) {
    throw new Error("Private plugin asset content changed");
  }
}

/** The producer receipt, not a pathname or existing code-link inventory, grants authority. */
export async function sealUpdateCandidatePluginAssets(
  stateDir: string,
  facts: readonly UpdateCandidatePluginCodeLink[],
) {
  const assets = facts.filter((fact) => fact.asset);
  for (const edge of assets) {
    if (edge.asset!.root.path !== stateDir) {
      throw new Error("Private plugin asset belongs to another state root");
    }
    assertUpdateCandidatePluginAsset(edge);
  }
  const receipt = await sealUpdateCandidatePluginCodeLinks(
    path.join(stateDir, inventoryName),
    assets,
  );
  return JSON.stringify({ stateDir, ...receipt });
}

export function readUpdateCandidatePluginAssets(
  stateDir: string,
  receiptText?: string,
): UpdateCandidatePluginCodeLink[] {
  if (!receiptText) {
    return [];
  }
  const receipt = UpdateCandidatePluginCodeLinkReceiptSchema.extend({ stateDir: z.string() }).parse(
    JSON.parse(receiptText),
  );
  if (receipt.stateDir !== stateDir || receipt.bytes > 8 * 1024 * 1024) {
    throw new Error("Private plugin asset receipt has the wrong state root or size");
  }
  const file = path.join(stateDir, inventoryName);
  assertPhysicalPath(stateDir, file);
  const opened = openRootFileSync({
    absolutePath: file,
    rootPath: stateDir,
    boundaryLabel: "private plugin asset receipt",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new Error("Cannot open private plugin asset receipt", { cause: opened.error });
  }
  let buffer: Buffer;
  try {
    buffer = readFileDescriptorBoundedSync(opened.fd, receipt.bytes);
  } finally {
    fs.closeSync(opened.fd);
  }
  if (buffer.length !== receipt.bytes || sha256Hex(buffer) !== receipt.sha256) {
    throw new Error("Private plugin asset receipt changed");
  }
  const edges = z
    .array(UpdateCandidatePluginCodeLinkSchema)
    .parse(JSON.parse(buffer.toString("utf8")));
  for (const edge of edges) {
    if (edge.asset?.root.path !== stateDir) {
      throw new Error("Private plugin asset belongs to another state root");
    }
    assertUpdateCandidatePluginAsset(edge);
  }
  return edges;
}
