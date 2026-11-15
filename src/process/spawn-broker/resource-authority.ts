import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitsBrokerSocketPath } from "./socket-directory.js";

function createNativeResourceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "oc-br-"));
  if (fitsBrokerSocketPath(directory, "resource.sock")) {
    return directory;
  }
  // A configured temp root can exceed Darwin's sockaddr_un even for a short private socket.
  rmSync(directory, { recursive: true, force: true });
  return mkdtempSync("/tmp/oc-br-");
}

export function createNativeResourceAuthority() {
  const directory = createNativeResourceDirectory();
  chmodSync(directory, 0o700);
  const secret = randomBytes(32).toString("hex");
  return {
    directory,
    secret,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\oc-br-${secret}`
        : join(directory, "resource.sock"),
  };
}
