import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
  };
});

import { withInstallWorkspace } from "./install-source-utils.js";

describe("withInstallWorkspace private root", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32").each(["missing", "writable"] as const)(
    "preserves parent temp root permissions when securing a %s OpenClaw temp root",
    async (state) => {
      const mockParentRoot = tempDirs.make("openclaw-chmod-test-");
      const mockOpenClawDir = path.join(mockParentRoot, "openclaw");

      if (state === "writable") {
        await fs.mkdir(mockOpenClawDir);
        await fs.chmod(mockOpenClawDir, 0o777);
      }
      await fs.chmod(mockParentRoot, 0o1777);
      const canonicalOpenClawDir = path.join(await fs.realpath(mockParentRoot), "openclaw");

      const { resolvePreferredOpenClawTmpDir } =
        await vi.importActual<typeof import("./tmp-openclaw-dir.js")>("./tmp-openclaw-dir.js");
      resolvePreferredOpenClawTmpDirMock.mockImplementation(() =>
        resolvePreferredOpenClawTmpDir({
          preferredDir: mockOpenClawDir,
          tmpdir: () => mockParentRoot,
          warn: vi.fn(),
        }),
      );

      let observedDir = "";
      const value = await withInstallWorkspace("openclaw-test-", async (tmpDir) => {
        observedDir = tmpDir;
        expect(path.dirname(tmpDir)).toBe(canonicalOpenClawDir);
        expect((await fs.stat(mockOpenClawDir)).mode & 0o7777).toBe(0o700);
        expect((await fs.stat(tmpDir)).mode & 0o7777).toBe(0o700);
        await fs.writeFile(path.join(tmpDir, "marker.txt"), "ok");
        return "done";
      });

      expect(value).toBe("done");

      await expect(
        fs.stat(observedDir).then(
          () => true,
          () => false,
        ),
      ).resolves.toBe(false);

      const privateRootStat = await fs.stat(mockOpenClawDir);
      expect(privateRootStat.mode & 0o7777).toBe(0o700);

      const parentStat = await fs.stat(mockParentRoot);
      expect(parentStat.mode & 0o7777).toBe(0o1777);
    },
  );
});
