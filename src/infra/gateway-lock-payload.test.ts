import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGatewayOwnerProcessNamespace,
  LINUX_PID_NAMESPACE_UNSUPPORTED,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

const BOOT_IDENTITY = "01234567-89ab-cdef-0123-456789abcdef";

function errno(code: string) {
  return Object.assign(new Error(`${code}: /proc/self/ns/pid`), { code });
}

function mockLinuxWithoutPidNamespaceLink(params: { linkError: string; nsDirPresent: boolean }) {
  vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
    platform: "linux",
    identity: BOOT_IDENTITY,
  }));
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const readlink = fs.readlinkSync.bind(fs);
  vi.spyOn(fs, "readlinkSync").mockImplementation((file, options) => {
    if (file === "/proc/self/ns/pid") {
      throw errno(params.linkError);
    }
    return readlink(file, options);
  });
  const stat = fs.statSync.bind(fs);
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (file === "/proc/self/ns") {
      if (!params.nsDirPresent) {
        throw errno("ENOENT");
      }
      return { isDirectory: () => true } as fs.Stats;
    }
    return stat(file, options as never);
  }) as typeof fs.statSync);
}

// The module caches a successful read; the failing cases run first so each
// case observes its own mock.
describe("readGatewayLockProcessNamespace without /proc/self/ns/pid", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays unreadable when the link cannot be read for another reason", () => {
    mockLinuxWithoutPidNamespaceLink({ linkError: "EACCES", nsDirPresent: true });
    expect(readGatewayLockProcessNamespace()).toBeNull();
  });

  it("stays unreadable when /proc itself is missing", () => {
    mockLinuxWithoutPidNamespaceLink({ linkError: "ENOENT", nsDirPresent: false });
    expect(readGatewayLockProcessNamespace()).toBeNull();
  });

  it("records one shared namespace on a kernel built without PID namespaces", () => {
    mockLinuxWithoutPidNamespaceLink({ linkError: "ENOENT", nsDirPresent: true });
    const current = readGatewayLockProcessNamespace();
    expect(current).toMatchObject({
      platform: "linux",
      host: os.hostname(),
      identity: BOOT_IDENTITY,
      pidNsInode: LINUX_PID_NAMESPACE_UNSUPPORTED,
    });
    // Same host and boot: a previous owner on this kernel is this namespace,
    // so PID liveness applies instead of waiting for its heartbeat to go stale.
    expect(classifyGatewayOwnerProcessNamespace({ ...current })).toBe("same");
    // A reboot still ends every process, whatever the namespace support.
    expect(
      classifyGatewayOwnerProcessNamespace({
        ...current,
        identity: "fedcba98-7654-3210-fedc-ba9876543210",
      }),
    ).toBe("dead");
  });
});
