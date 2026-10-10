import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

const { readDirectoryAcl, rosetta } = vi.hoisted(() => ({
  readDirectoryAcl: vi.fn(() => "none"),
  rosetta: vi.fn(() => false),
}));
// mock-isolation: the real module loads libSystem through koffi at import, unavailable off macOS.
vi.mock("./filesystem-apfs.native.js", () => ({ apfsFilesystem: { readDirectoryAcl } }));
// mock-isolation: the real detector reads and caches the test host's CPU brand.
vi.mock("../../shared/rosetta-translation.js", () => ({ isRosettaTranslatedProcess: rosetta }));

describe.skipIf(process.platform === "win32")("worktree filesystem backend", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  afterEach(() => vi.restoreAllMocks());

  it("falls back when native cloning is unavailable", async () => {
    const root = tempDirs.make("openclaw-filesystem-backend-");
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue(undefined);
    await expect(detectWorktreeFilesystemBackend(root, options)).resolves.toBeNull();
  });

  it("keeps Rosetta-translated APFS worktrees on Git checkout", async () => {
    const root = tempDirs.make("openclaw-filesystem-backend-");
    rosetta.mockReturnValueOnce(true);
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue("apfs");
    await expect(detectWorktreeFilesystemBackend(root, options)).resolves.toBeNull();
    expect(readDirectoryAcl).not.toHaveBeenCalled();
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
