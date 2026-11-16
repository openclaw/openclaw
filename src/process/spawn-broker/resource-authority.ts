import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitsBrokerSocketPath } from "./socket-directory.js";

/** Allocate authority without touching disk; the broker creates its private socket directory. */
export function createNativeResourceAuthority() {
  const name = `oc-br-${randomBytes(16).toString("hex")}`;
  const preferred = join(tmpdir(), name);
  const directory =
    process.platform === "win32"
      ? undefined
      : fitsBrokerSocketPath(preferred, "resource.sock")
        ? preferred
        : join("/tmp", name);
  const secret = randomBytes(32).toString("hex");
  return {
    directory,
    secret,
    endpoint: directory ? join(directory, "resource.sock") : `\\\\.\\pipe\\oc-br-${secret}`,
  };
}
