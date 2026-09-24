import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

describe.skipIf(process.platform === "win32")("worktree filesystem backend", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  afterEach(() => vi.restoreAllMocks());

  it("falls back when native cloning is unavailable", async () => {
    const root = tempDirs.make("openclaw-filesystem-backend-");
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue(undefined);
    await expect(detectWorktreeFilesystemBackend(root, options)).resolves.toBeNull();
  });

  it.each(["abort", "authority"])(
    "does not hide %s loss behind an unavailable filesystem probe",
    async (reason) => {
      const root = tempDirs.make("openclaw-filesystem-backend-");
      const controller = new AbortController();
      let authorized = true;
      vi.spyOn(nativeWorktreeFilesystem, "probe").mockImplementation(async () => {
        authorized = false;
        if (reason === "abort") {
          controller.abort(new Error("allocation canceled"));
        }
        return undefined;
      });
      await expect(
        detectWorktreeFilesystemBackend(root, {
          signal: controller.signal,
          commitGuard() {
            if (!authorized) {
              throw new Error("allocation lease lost");
            }
          },
        }),
      ).rejects.toThrow(reason === "abort" ? "allocation canceled" : "allocation lease lost");
    },
  );
});
