import { createHash } from "node:crypto";

// SHA-256 of dist/package-update-activation-recovery.mjs in openclaw@2026.9.8.
export const LEGACY_PACKAGE_RECOVERY_HELPER =
  "e08dfc1fb3ba7962f9e01d7a6770117c6cd77406b3fa4f7ba94788a670030ba0";
export const LEGACY_PACKAGE_SETTLEMENT_WARNING =
  "legacy package record settled by identity and version; content could not be re-verified";

/** Reproduce the published 2026.9.8 seal from the reader's verified preorder inventory. */
export function legacyPackageTreeDigest(
  entries: Array<{ relative: string; fields: Map<string, string> | undefined }>,
): string {
  const digest = createHash("sha256");
  const hardlinks = new Map<string, string>();
  for (const { relative, fields } of entries) {
    if (!fields) {
      throw new Error("Legacy package inventory is incomplete.");
    }
    const metadata = ["dev:ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].map(
      (key) => fields.get(key),
    );
    if (!relative) {
      metadata.pop();
    }
    digest.update(JSON.stringify([relative, metadata]));
    const target = fields.get("target");
    const contents = fields.get("sha256");
    if (target !== undefined) {
      digest.update(JSON.stringify(["symlink", target]));
    } else if (contents !== undefined) {
      const identity = fields.get("dev:ino")!;
      const owner =
        BigInt(fields.get("nlink")!) > 1n ? (hardlinks.get(identity) ?? relative) : null;
      if (owner !== null) {
        hardlinks.set(identity, owner);
      }
      digest.update(JSON.stringify(["file", owner, contents]));
    }
  }
  return digest.digest("hex");
}
