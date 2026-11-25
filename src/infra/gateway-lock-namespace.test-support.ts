import fs from "node:fs";
import { vi } from "vitest";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

export function mockLinuxNamespace(root: string) {
  if (process.platform !== "linux") {
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const namespaceLink = `pid:[${fs.statSync(root, { bigint: true }).ino}]`;
    const readlink = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, "readlinkSync").mockImplementation((file, options) =>
      file === "/proc/self/ns/pid" ? namespaceLink : readlink(file, options),
    );
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readGatewayLockProcessNamespace();
    platform.mockRestore();
  }
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("pidNsInode" in namespace)) {
    throw new Error("Expected Linux process namespace identity");
  }
  return namespace;
}
