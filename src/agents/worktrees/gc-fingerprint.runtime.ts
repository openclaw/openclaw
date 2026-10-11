import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readGitMetadataDirectories, readGitRefs } from "../../infra/git-root.js";

/** A deferral is a scheduling hint, never permission to delete a checkout. */
export async function readWorktreeCleanupFingerprint(checkoutPath: string): Promise<string | null> {
  try {
    const directories = readGitMetadataDirectories(checkoutPath);
    if (!directories) {
      return null;
    }
    const { gitDir: gitdir, commonDir: common } = directories;
    const head = await fs.readFile(path.join(gitdir, "HEAD"), "utf8");
    const reference = head.startsWith("ref: ") ? head.slice(5).trim() : undefined;
    const tip = reference ? readGitRefs(common, [reference]).get(reference) : head;
    const identities = await Promise.all(
      [
        checkoutPath,
        path.join(checkoutPath, ".git"),
        path.join(gitdir, "HEAD"),
        path.join(gitdir, "index"),
      ].map(async (entry) => {
        const stat = await fs.lstat(entry, { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
      }),
    );
    return createHash("sha256")
      .update(JSON.stringify([directories, head, tip, identities]))
      .digest("hex");
  } catch {
    return null;
  }
}
