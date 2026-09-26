import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
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
const nativeConfig = getFsSafeNativeConfig();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  configureFsSafeNative(nativeConfig);
  durabilityTestState.publishSyncOutcome = undefined;
  vi.restoreAllMocks();
});

function forceJavaScriptCopyFallback() {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(fs, "link").mockRejectedValue(
    Object.assign(new Error("unsupported"), { code: "ENOTSUP" }),
  );
}

describe("directory durability compatibility", () => {
  it.each(["hardlink", "exclusive-copy"] as const)(
    "moves its source after strict no-clobber publication completes (%s)",
    async (method) => {
      const directoryPath = tempDirs.make("openclaw-publish-move-");
      const sourcePath = path.join(directoryPath, "source.txt");
      const targetPath = path.join(directoryPath, "target.txt");
      await fs.writeFile(sourcePath, "complete publication");
      if (method === "exclusive-copy") {
        forceJavaScriptCopyFallback();
      }

      const publication = await publishFileNoClobber(sourcePath, targetPath, {
        strategy: method === "hardlink" ? "link-required" : "link-or-copy",
        moveSource: true,
        durability: "fail-closed",
      });

      expect(publication.method).toBe(method);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete publication");
      await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { method: "hardlink", moveSource: true },
    { method: "hardlink", moveSource: false },
    { method: "exclusive-copy", moveSource: true },
    { method: "exclusive-copy", moveSource: false },
  ] as const)(
    "preserves source when target is replaced during publication sync ($method, moveSource: $moveSource)",
    async ({ method, moveSource }) => {
      const directoryPath = tempDirs.make("openclaw-publish-target-replaced-");
      const sourcePath = path.join(directoryPath, "source.txt");
      const targetPath = path.join(directoryPath, "target.txt");
      const replacementPath = path.join(directoryPath, "replacement.txt");
      await fs.writeFile(sourcePath, "complete publication");
      await fs.writeFile(replacementPath, "racer");
      const sourceIdentity = await fs.lstat(sourcePath, { bigint: true });
      const replacementIdentity = await fs.lstat(replacementPath, { bigint: true });
      expect({ dev: sourceIdentity.dev, ino: sourceIdentity.ino }).not.toEqual({
        dev: replacementIdentity.dev,
        ino: replacementIdentity.ino,
      });
      if (method === "exclusive-copy") {
        forceJavaScriptCopyFallback();
      }
      const publicationMethods: string[] = [];
      __setFsSafeTestHooksForTest({
        beforePublishDirectorySync: async (publishedMethod, publishedPath) => {
          if (path.resolve(publishedPath) === targetPath && publicationMethods.length === 0) {
            publicationMethods.push(publishedMethod);
            await fs.rename(replacementPath, targetPath);
          }
        },
      });

      const [publication] = await Promise.allSettled([
        publishFileNoClobber(sourcePath, targetPath, {
          strategy: method === "hardlink" ? "link-required" : "link-or-copy",
          moveSource,
          durability: "fail-closed",
        }),
      ]);
      const [source, target] = await Promise.allSettled([
        fs.readFile(sourcePath, "utf8"),
        fs.readFile(targetPath, "utf8"),
      ]);

      expect({
        publicationMethods,
        publication: publication.status,
        details:
          publication.status === "rejected"
            ? getPublishFileExclusiveFailureDetails(publication.reason)
            : undefined,
        source,
        target,
      }).toMatchObject({
        publicationMethods: [method],
        publication: "rejected",
        details: { targetCreated: true, cleanup: "preserved" },
        source: { status: "fulfilled", value: "complete publication" },
        target: { status: "fulfilled", value: "racer" },
      });
    },
  );

  it.each(["hardlink", "exclusive-copy"] as const)(
    "preserves a source replacement during %s publication sync",
    async (method) => {
      const directoryPath = tempDirs.make("openclaw-publish-source-replaced-");
      const sourcePath = path.join(directoryPath, "source.txt");
      const targetPath = path.join(directoryPath, "target.txt");
      const replacementPath = path.join(directoryPath, "replacement.txt");
      await fs.writeFile(sourcePath, "complete publication");
      await fs.writeFile(replacementPath, "foreign source");
      if (method === "exclusive-copy") {
        forceJavaScriptCopyFallback();
      }
      const publicationMethods: string[] = [];
      __setFsSafeTestHooksForTest({
        beforePublishDirectorySync: async (publishedMethod, publishedPath) => {
          if (path.resolve(publishedPath) === targetPath && publicationMethods.length === 0) {
            publicationMethods.push(publishedMethod);
            await fs.rename(replacementPath, sourcePath);
          }
        },
      });

      const error = await publishFileNoClobber(sourcePath, targetPath, {
        strategy: method === "hardlink" ? "link-required" : "link-or-copy",
        moveSource: true,
        durability: "fail-closed",
      }).catch((caught: unknown) => caught);

      expect(publicationMethods).toEqual([method]);
      expect(getPublishFileExclusiveFailureDetails(error)).toMatchObject({
        targetCreated: true,
        cleanup: "preserved",
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("foreign source");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete publication");
    },
  );

  it("accepts completed and unnecessary strict sync outcomes", () => {
    expect(() => requireDirectorySync({ status: "synced" }, "test directory")).not.toThrow();
    expect(() => requireDirectorySync({ status: "not-needed" }, "test directory")).not.toThrow();
  });

  it("rejects unsupported strict sync outcomes with their platform code", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(() =>
      requireDirectorySync({ status: "unsupported", code: "ENOTSUP" }, "test directory"),
    ).toThrow(
      /test directory does not support crash-durable directory synchronization \(ENOTSUP\)/u,
    );
  });

  it("accepts unsupported strict sync outcomes on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(() =>
      requireDirectorySync({ status: "unsupported", code: "EPERM" }, "test directory"),
    ).not.toThrow();
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

  it.runIf(process.platform !== "win32")("reports a completed directory sync", async () => {
    const directoryPath = tempDirs.make("openclaw-directory-sync-");

    await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({ status: "synced" });
  });

  it.each(["EINVAL", "ENOSYS", "ENOTSUP"] as const)(
    "keeps the existing %s unsupported-filesystem compatibility",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directoryPath = tempDirs.make("openclaw-directory-unsupported-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({
        status: "unsupported",
        code,
      });
    },
  );

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

  it.each(["EACCES", "EPERM"] as const)(
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
