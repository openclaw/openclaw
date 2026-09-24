import { FsSafeError } from "@openclaw/fs-safe/errors";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { writeFileWithinRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { root } from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();
let nativeModeEnv: ReturnType<typeof captureEnv>;
const relativePath = "nested/file.txt";
const writeRoutes = {
  write: async (rootDir: string) => (await root(rootDir)).write(relativePath, "next"),
  create: async (rootDir: string) => (await root(rootDir)).create(relativePath, "next"),
  createStream: async (rootDir: string) =>
    (await root(rootDir)).create(
      relativePath,
      (async function* () {
        yield Buffer.from("next");
      })(),
    ),
  writeJson: async (rootDir: string) =>
    (await root(rootDir)).writeJson(relativePath, { next: true }),
  createJson: async (rootDir: string) =>
    (await root(rootDir)).createJson(relativePath, { next: true }),
  writeFileWithinRoot: async (rootDir: string) =>
    writeFileWithinRoot({ rootDir, relativePath, data: "next" }),
};

beforeEach(() => {
  nativeModeEnv = captureEnv(["FS_SAFE_NATIVE_MODE"]);
  // This fault hook exercises JavaScript preparation, which remains supported in off mode.
  setTestEnvValue("FS_SAFE_NATIVE_MODE", "off");
});

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  nativeModeEnv.restore();
  await tempDirs.cleanup();
});

function failPinnedWriteWith(error: Error): void {
  // Fail inside the dependency's commit boundary before it publishes any file.
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: () => {
      throw error;
    },
  });
}

async function captureWriteError(write: () => Promise<void>): Promise<FsSafeError> {
  const caught = await write().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof FsSafeError)) {
    throw new Error(`expected FsSafeError, got ${String(caught)}`);
  }
  return caught;
}

// fs-safe's Windows write fallback does not invoke this fault hook.
describe.skipIf(process.platform === "win32")("pinned write errno reporting", () => {
  it.each(Object.entries(writeRoutes))(
    "preserves the permission cause and classification through %s",
    async (_name, write) => {
      const rootDir = await tempDirs.make("openclaw-pinned-write-");
      const cause = Object.assign(new Error("permission failure"), { code: "EACCES" });
      failPinnedWriteWith(cause);

      const error = await captureWriteError(() => write(rootDir));

      expect(error.message).toBe("permission denied (EACCES)");
      expect(error.code).toBe("invalid-path");
      expect(error.category).toBe("policy");
      expect(error.cause).toBe(cause);
    },
  );

  it.each([
    ["EPERM", "permission denied (EPERM)"],
    ["EROFS", "read-only filesystem (EROFS)"],
    ["ENOSPC", "no space left on device (ENOSPC)"],
    ["EIO", "filesystem write failed (EIO)"],
  ])("reports the underlying %s failure", async (code, message) => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-errno-");
    const cause = Object.assign(new Error("filesystem failure"), { code });
    failPinnedWriteWith(cause);

    const error = await captureWriteError(() => writeRoutes.write(rootDir));

    expect(error.message).toBe(message);
    expect(error.code).toBe("invalid-path");
    expect(error.cause).toBe(cause);
  });

  it("keeps the original diagnostic when the failure has no errno", async () => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-plain-");
    const cause = new Error("no errno here");
    failPinnedWriteWith(cause);

    const error = await captureWriteError(() => writeRoutes.writeFileWithinRoot(rootDir));

    expect(error.message).toBe("path is not a regular file under root");
    expect(error.cause).toBe(cause);
  });

  it.each([
    "not-found",
    "symlink",
    "not-file",
    "already-exists",
    "hardlink",
    "outside-workspace",
  ] as const)("preserves an already classified %s error", async (code) => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-classified-");
    const error = new FsSafeError(code, "path is not a regular file under root", {
      cause: Object.assign(new Error("permission failure"), { code: "EACCES" }),
      details: { boundary: "classified" },
    });
    failPinnedWriteWith(error);

    await expect(writeRoutes.writeFileWithinRoot(rootDir)).rejects.toBe(error);
  });
});
