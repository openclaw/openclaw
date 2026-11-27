import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitsBrokerSocketPath } from "./socket-directory.js";

export type NativeResourceAuthority = {
  endpoint: string;
  attachmentsOnly?: true;
  /** Private socket directory for the endpoint; undefined when the endpoint needs none. */
  directory: string | undefined;
  secret: string;
};

/**
 * Allocate authority without touching disk. Whether the endpoint has a private socket directory
 * is decided only here and forwarded whole to the broker, which creates and removes it. The host
 * removes it again after readiness in case the broker could not.
 */
export function createNativeResourceAuthority(attachmentsOnly?: true): NativeResourceAuthority {
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
    ...(attachmentsOnly ? { attachmentsOnly } : {}),
    directory,
    secret,
    endpoint: directory ? join(directory, "resource.sock") : `\\\\.\\pipe\\oc-br-${secret}`,
  };
}
