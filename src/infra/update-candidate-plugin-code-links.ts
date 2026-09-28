import { lstatSync, readlinkSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { root } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";

const identity = { dev: z.string(), ino: z.string() };
const UpdateCandidatePluginCodeLinkSchema = z.object({
  path: z.string(),
  ...identity,
  link: z.string(),
  target: z.object({ path: z.string(), ...identity }).nullable(),
});
export type UpdateCandidatePluginCodeLink = z.infer<typeof UpdateCandidatePluginCodeLinkSchema>;

function targetIdentity(file: string): UpdateCandidatePluginCodeLink["target"] {
  try {
    const target = realpathSync(file);
    const stat = statSync(target, { bigint: true });
    return { path: target, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch (error) {
    // The producer permits internal dangling links. Becoming reachable later is
    // a changed binding, just as replacing an existing target is.
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
      return null;
    }
    throw error;
  }
}

/** Capture only after the plugin projection owner has validated this code edge. */
export function captureUpdateCandidatePluginCodeLink(
  file: string,
  stat: BigIntStats,
  link: string,
): UpdateCandidatePluginCodeLink {
  const fact = {
    path: file,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    link,
    target: targetIdentity(file),
  };
  assertUpdateCandidatePluginCodeLink(fact);
  return fact;
}

/** Recheck both the link inode and its physical target; never traverse it as data. */
export function assertUpdateCandidatePluginCodeLink(fact: UpdateCandidatePluginCodeLink): void {
  const stat = lstatSync(fact.path, { bigint: true });
  if (
    !stat.isSymbolicLink() ||
    stat.dev.toString() !== fact.dev ||
    stat.ino.toString() !== fact.ino ||
    readlinkSync(fact.path) !== fact.link ||
    !isDeepStrictEqual(targetIdentity(fact.path), fact.target)
  ) {
    throw new Error(`Copied plugin code link changed: ${fact.path}`);
  }
}

export const UpdateCandidatePluginCodeLinkReceiptSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
});

/** Reuse the consumed plan file; large dependency graphs must not fill worker stdout. */
export async function sealUpdateCandidatePluginCodeLinks(
  file: string,
  links: readonly UpdateCandidatePluginCodeLink[],
) {
  const data = JSON.stringify(links);
  const directory = await root(path.dirname(file));
  await directory.write(path.basename(file), data, { mode: 0o600 });
  return { sha256: sha256Hex(data), bytes: Buffer.byteLength(data) };
}

/** The settled producer's stdout binds the private file, not caller-controlled JSON. */
export async function readUpdateCandidatePluginCodeLinks(
  file: string,
  receipt: z.infer<typeof UpdateCandidatePluginCodeLinkReceiptSchema>,
) {
  const directory = await root(path.dirname(file));
  const { buffer } = await directory.read(path.basename(file), {
    maxBytes: receipt.bytes,
    symlinks: "reject",
    hardlinks: "reject",
  });
  if (buffer.length !== receipt.bytes || sha256Hex(buffer) !== receipt.sha256) {
    throw new Error("Copied plugin code link inventory changed after snapshot");
  }
  return z.array(UpdateCandidatePluginCodeLinkSchema).parse(JSON.parse(buffer.toString("utf8")));
}
