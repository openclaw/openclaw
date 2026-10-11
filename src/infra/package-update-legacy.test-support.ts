import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Frozen byte format from v2026.9.8 package-update-integrity.ts, independent of today's reader.
export function legacyPackageFingerprint(root: string) {
  const digest = createHash("sha256");
  const hardlinks = new Map<string, string>();
  const visit = (file: string, relative: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    const metadata = [
      identity,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].map(String);
    if (!relative) {
      metadata.pop();
    }
    digest.update(JSON.stringify([relative, metadata]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(file, name), relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isSymbolicLink()) {
      digest.update(JSON.stringify(["symlink", fs.readlinkSync(file)]));
    } else {
      const owner = stat.nlink > 1n ? (hardlinks.get(identity) ?? relative) : null;
      if (owner !== null) {
        hardlinks.set(identity, owner);
      }
      digest.update(
        JSON.stringify([
          "file",
          owner,
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ]),
      );
    }
  };
  visit(root, "");
  const stat = fs.lstatSync(root, { bigint: true });
  return {
    digest: digest.digest("hex"),
    identity: `${stat.dev}:${stat.ino}`,
    version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version as string,
  };
}
