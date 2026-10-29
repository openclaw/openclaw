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
  it.each([
    ["write", "EACCES", "permission denied (EACCES)"],
    ["create", "EACCES", "permission denied (EACCES)"],
    ["createStream", "EACCES", "permission denied (EACCES)"],
    ["writeFileWithinRoot", "EACCES", "permission denied (EACCES)"],
    ["write", "EPERM", "permission denied (EPERM)"],
    ["write", "EROFS", "read-only filesystem (EROFS)"],
    ["write", "ENOSPC", "no space left on device (ENOSPC)"],
    ["write", "EIO", "filesystem write failed (EIO)"],
    ["writeFileWithinRoot", undefined, "path is not a regular file under root"],
  ] as const)("reports %s failures with errno %s", async (route, code, message) => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-errno-");
    const cause = Object.assign(new Error("filesystem failure"), { code });
    failPinnedWriteWith(cause);
    const error = await captureWriteError(() => writeRoutes[route](rootDir));
    expect(error.message).toBe(message);
    expect(error.code).toBe("invalid-path");
    expect(error.category).toBe("policy");
    expect(error.cause).toBe(cause);
  });

  it("preserves an already classified boundary error", async () => {
    const rootDir = await tempDirs.make("openclaw-pinned-write-classified-");
    const error = new FsSafeError("outside-workspace", "path is not a regular file under root", {
      cause: Object.assign(new Error("permission failure"), { code: "EACCES" }),
      details: { boundary: "classified" },
    });
    failPinnedWriteWith(error);

    await expect(writeRoutes.writeFileWithinRoot(rootDir)).rejects.toBe(error);
  });
});
