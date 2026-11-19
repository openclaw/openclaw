import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureOwnerDirectory } from "./gateway-state-owner-directory.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

describe.skipIf(process.platform === "win32")("ensureOwnerDirectory", () => {
  it("names the directory and the storage requirement when another uid owns it", () => {
    // Shared mounts such as VirtioFS present every file as root-owned.
    const root = directories.make("openclaw-owner-dir-");
    const directory = path.join(root, "tmp", "openclaw-1001");
    const realUid = fs.statSync(root).uid;
    vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);

    expect(() => ensureOwnerDirectory(directory)).toThrow(
      `State ownership directory ${directory} is owned by uid ${realUid}, not this user (uid ${realUid + 1}). Run OpenClaw as the user that owns its state directory, and keep that directory on a local filesystem that supports file ownership and permissions`,
    );
  });
});
