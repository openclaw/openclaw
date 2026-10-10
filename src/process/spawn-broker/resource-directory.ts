import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNIX_SOCKET_PATH_BYTES = 103;

export function createNativeResourceDirectory(): string {
  let directory = mkdtempSync(join(tmpdir(), "oc-br-"));
  if (
    process.platform !== "win32" &&
    Buffer.byteLength(join(directory, "resource.sock")) > UNIX_SOCKET_PATH_BYTES
  ) {
    // A configured temp root can exceed Darwin's sockaddr_un even for a short private socket.
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync("/tmp/oc-br-");
  }
  chmodSync(directory, 0o700);
  return directory;
}
