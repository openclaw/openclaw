import type { BigIntStats } from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import type { RootCopyPublicationReceipt } from "@openclaw/fs-safe/root";
import { root } from "./fs-safe.js";

/** Copy a physical SQLite file, not a coherent family. Its caller owns coherence and byte checks. */
export async function copySqliteFile(
  sourcePath: string,
  targetPath: string,
  expectedIdentity: BigIntStats,
): Promise<RootCopyPublicationReceipt> {
  const sourceRoot = await root(path.dirname(sourcePath));
  const targetRoot = await root(path.dirname(targetPath));
  let published: RootCopyPublicationReceipt | undefined;
  await targetRoot.copyIn(
    path.basename(targetPath),
    {
      relativePath: path.basename(sourcePath),
      root: {
        stat: (relativePath) => sourceRoot.stat(relativePath),
        open: async (relativePath, options) => {
          const opened = await sourceRoot.open(relativePath, options);
          try {
            if (!sameFileIdentity(expectedIdentity, await opened.handle.stat({ bigint: true }))) {
              throw new Error(`SQLite copy source changed: ${sourcePath}`);
            }
            return opened;
          } catch (error) {
            await opened.handle.close();
            throw error;
          }
        },
      },
    },
    {
      clone: "auto",
      // Reading an admitted alias is safe: this creates an independent inode.
      // Recovery inventories keep their stricter one-link admission policy.
      sourceHardlinks: "allow",
      overwrite: false,
      mode: 0o600,
      durable: true,
      onDestinationPublished: (receipt) => {
        published = receipt;
      },
    },
  );
  if (!published) {
    throw new Error(`SQLite copy was not published: ${targetPath}`);
  }
  return published;
}
