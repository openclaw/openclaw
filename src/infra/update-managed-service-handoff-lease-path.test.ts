import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import * as temporaryRoot from "./tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "keeps the per-user lease path when another user owns the shared temp directory",
  () => {
    vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
    vi.spyOn(process, "getuid").mockReturnValue(501);
    let sharedOwner = 501;
    const resolve = temporaryRoot.resolvePreferredOpenClawTmpDir;
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockImplementation((options) =>
      resolve({
        ...options,
        platform: "linux",
        getuid: () => 501,
        tmpdir: () => "/tmp",
        accessSync: () => {},
        mkdirSync: () => {},
        lstatSync: (directory) => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o40700,
          uid: directory === "/tmp/openclaw" ? sharedOwner : 501,
        }),
      }),
    );

    expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
      "/tmp/openclaw-501/managed-update-handoffs.sqlite",
    );
    sharedOwner = 502;
    expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
      "/tmp/openclaw-501/managed-update-handoffs.sqlite",
    );
  },
);
