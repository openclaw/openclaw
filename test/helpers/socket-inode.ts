import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

/** Create a real, non-listening socket inode in a caller-owned temporary directory. */
export function createSocketInode(directory: string, name: string): string {
  // Bind relative to the child's cwd: the absolute workspace/TMPDIR path can exceed
  // sockaddr_un. Exit without server.close(), which would unlink the inode under test.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.exit(0));',
      name,
    ],
    { cwd: directory, encoding: "utf8", timeout: 10_000 },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`socket inode fixture failed (status ${result.status}): ${result.stderr}`);
  }
  const socketPath = path.join(directory, name);
  if (!lstatSync(socketPath).isSocket()) {
    throw new Error("socket inode fixture did not create a socket");
  }
  return socketPath;
}
