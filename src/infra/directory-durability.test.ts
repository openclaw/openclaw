import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getPublishFileExclusiveFailureDetails,
  publishFileNoClobber,
  requireDirectorySync,
  syncDirectoryIfSupported,
} from "./directory-durability.js";

const durabilityTestState = vi.hoisted(() => ({
  publishSyncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      const result = await actual.publishFileExclusive(...args);
      return durabilityTestState.publishSyncOutcome
        ? { ...result, directorySync: durabilityTestState.publishSyncOutcome }
        : result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  durabilityTestState.publishSyncOutcome = undefined;
  vi.restoreAllMocks();
});

describe("directory durability compatibility", () => {
  it("accepts completed and unnecessary strict sync outcomes", () => {
    expect(() => requireDirectorySync({ status: "synced" }, "test directory")).not.toThrow();
    expect(() => requireDirectorySync({ status: "not-needed" }, "test directory")).not.toThrow();
  });

  it("preserves its target with a receipt when fail-closed durability rejects", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const directoryPath = tempDirs.make("openclaw-publish-cleanup-");
    const sourcePath = path.join(directoryPath, "source.txt");
    const targetPath = path.join(directoryPath, "target.txt");
    await fs.writeFile(sourcePath, "complete publication");
    durabilityTestState.publishSyncOutcome = { status: "unsupported", code: "ENOTSUP" };

    const error = await publishFileNoClobber(sourcePath, targetPath, {
      strategy: "link-or-copy",
      durability: "fail-closed",
    }).catch((caught: unknown) => caught);

    expect(getPublishFileExclusiveFailureDetails(error)).toMatchObject({
      phase: "directory-sync",
      targetCreated: true,
      cleanup: "preserved",
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("complete publication");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete publication");
  });

  it("propagates real directory I/O failures", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const directoryPath = tempDirs.make("openclaw-directory-io-");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("I/O"), { code: "EIO" }));
      return handle;
    });

    await expect(syncDirectoryIfSupported(directoryPath)).rejects.toMatchObject({ code: "EIO" });
  });

  it.each(["EACCES"] as const)(
    "preserves Windows %s directory-open compatibility",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const directoryPath = tempDirs.make("openclaw-directory-windows-");
      vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error(code), { code }));

      await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({
        status: "unsupported",
        code,
      });
    },
  );
});
