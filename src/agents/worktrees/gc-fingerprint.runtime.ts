import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "../../infra/errno.js";
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
    const identities = await Promise.all([
      ...[
        checkoutPath,
        path.join(checkoutPath, ".git"),
        path.join(gitdir, "HEAD"),
        path.join(gitdir, "index"),
      ].map((entry) => fs.lstat(entry, { bigint: true })),
      // Scratch retirement leaves the checkout root, HEAD and index unchanged.
      fs.lstat(path.join(checkoutPath, ".openclaw/tmp"), { bigint: true }).catch(ignoreMissingPath),
    ]);
    return createHash("sha256")
      .update(
        JSON.stringify([
          directories,
          head,
          tip,
          identities.map(
            (stat) =>
              stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
          ),
        ]),
      )
      .digest("hex");
  } catch {
    return null;
  }
}
