import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  buildRandomTempFilePath,
  readDirectoryIdentity,
  sameFileIdentity,
} from "@openclaw/fs-safe/advanced";
import { syncDirectoryBestEffort } from "../infra/directory-durability.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  type captureChannelReadScope,
  settleChannelReadResource,
} from "../shared/channel-read-authority.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { MEDIA_FILE_MODE } from "./store.shared.js";

type ReadScope = NonNullable<ReturnType<typeof captureChannelReadScope>>;

const exitCleanups = resolveGlobalSingleton(Symbol.for("openclaw.readMediaExitCleanup"), () => {
  const callbacks = new Set<() => void>();
  process.once("exit", () => {
    for (const cleanup of callbacks) {
      try {
        cleanup();
      } catch (error) {
        console.error(
          `Channel read output cleanup failed at exit: ${redactToolPayloadText(String(error))}`,
        );
      }
    }
  });
  return callbacks;
});

function isUnownedMediaPath(error: unknown): boolean {
  return (
    (error instanceof FsSafeError &&
      ["not-found", "not-file", "path-mismatch", "symlink", "hardlink"].includes(error.code)) ||
    (error instanceof Error && "code" in error && error.code === "ENOENT")
  );
}

async function captureDirectoryGuard(dir: string): Promise<(handle?: FileHandle) => void> {
  const expected = await readDirectoryIdentity(dir);
  return (handle) => {
    assertDirectoryIdentitySync(dir, expected);
    if (handle && !sameFileIdentity(fsSync.fstatSync(handle.fd, { bigint: true }), expected)) {
      throw new FsSafeError("path-mismatch", "Media output directory identity changed");
    }
  };
}

/** Keeps a read's original file descriptor until its enclosing host accepts the result. */
export async function writeReadScopeMedia<T extends { id: string }>(params: {
  dir: string;
  tempPrefix: string;
  scope: ReadScope;
  durable?: boolean;
  write: (handle: FileHandle) => Promise<T>;
}): Promise<T> {
  params.scope.assertCurrent();
  const assertRequestedDirectory = await captureDirectoryGuard(params.dir);
  const mediaRoot = await root(params.dir);
  const assertMediaDirectory = await captureDirectoryGuard(mediaRoot.rootReal);
  if (process.platform !== "win32") {
    const directory = await fs.open(
      mediaRoot.rootReal,
      fsSync.constants.O_RDONLY |
        fsSync.constants.O_DIRECTORY |
        fsSync.constants.O_NOFOLLOW |
        fsSync.constants.O_NONBLOCK,
    );
    try {
      params.scope.assertCurrent();
      assertRequestedDirectory();
      assertMediaDirectory(directory);
      await directory.chmod(0o700).catch(() => undefined);
    } finally {
      await settleChannelReadResource(
        { key: mediaRoot.rootReal, settle: async () => await directory.close() },
        true,
      );
    }
  }
  params.scope.assertCurrent();
  // Own one sibling file; cleanup must never recurse into substituted staging contents.
  const temporaryPath = buildRandomTempFilePath({
    rootDir: mediaRoot.rootReal,
    prefix: params.tempPrefix,
    extension: ".tmp",
  });
  const temporaryName = path.basename(temporaryPath);
  let handle: FileHandle | undefined;
  let finalId: string | undefined;
  let handedOff = false;
  let settlement: Promise<void> | undefined;
  let assertOwnedFile: ((filePath: string) => void) | undefined;
  let cleanupAtExit: (() => void) | undefined;
  const resource = {
    get key() {
      return finalId ? path.join(params.dir, finalId) : temporaryPath;
    },
    assertCurrent: () => {
      if (settlement) {
        return;
      }
      assertRequestedDirectory();
      assertMediaDirectory();
      if (finalId) {
        assertOwnedFile?.(path.join(mediaRoot.rootReal, finalId));
      }
    },
    settle: (accepted: boolean) =>
      (settlement ??= (async () => {
        if (accepted && cleanupAtExit) {
          exitCleanups.delete(cleanupAtExit);
        }
        const failures: unknown[] = [];
        try {
          if (!accepted && handle) {
            if (!assertOwnedFile) {
              throw new FsSafeError("path-mismatch", "Cannot verify created media for cleanup");
            }
            for (const name of [finalId, temporaryName]) {
              if (!name) {
                continue;
              }
              try {
                await mediaRoot.remove(name, {
                  assertBeforeMutation: () => {
                    assertMediaDirectory();
                    assertOwnedFile?.(path.join(mediaRoot.rootReal, name));
                  },
                });
              } catch (error) {
                // A missing or substituted output is not ours to remove. Operational
                // failures still reach the read owner's cleanup diagnostics.
                if (!isUnownedMediaPath(error)) {
                  failures.push(error);
                }
              }
            }
          }
        } catch (error) {
          failures.push(error);
        }
        if (cleanupAtExit) {
          exitCleanups.delete(cleanupAtExit);
        }
        try {
          await handle?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to release channel read output");
        }
      })()),
  };
  try {
    params.scope.assertCurrent();
    handle = await fs.open(temporaryPath, "wx", MEDIA_FILE_MODE);
    const retained = handle;
    const expected = fsSync.fstatSync(retained.fd, { bigint: true });
    assertOwnedFile = (filePath) => {
      const opened = fsSync.fstatSync(retained.fd, { bigint: true });
      const current = fsSync.lstatSync(filePath, { bigint: true });
      if (
        !opened.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        opened.nlink !== 1n ||
        current.nlink !== 1n ||
        opened.dev !== expected.dev ||
        opened.ino !== expected.ino ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        (process.platform === "win32" && (expected.dev === 0n || expected.ino === 0n))
      ) {
        throw new FsSafeError("path-mismatch", "Media output no longer names the created file");
      }
    };
    cleanupAtExit = () => {
      for (const name of [finalId, temporaryName]) {
        if (!name) {
          continue;
        }
        try {
          const filePath = path.join(mediaRoot.rootReal, name);
          assertMediaDirectory();
          assertOwnedFile?.(filePath);
          fsSync.unlinkSync(filePath);
        } catch (error) {
          if (!isUnownedMediaPath(error)) {
            throw error;
          }
        }
      }
    };
    exitCleanups.add(cleanupAtExit);
    const result = await params.write(retained);
    params.scope.assertCurrent();
    assertRequestedDirectory();
    assertMediaDirectory();
    assertOwnedFile(temporaryPath);
    // Match sibling publication's mode finalization, including restrictive caller umasks.
    try {
      await retained.chmod(MEDIA_FILE_MODE);
    } catch (error) {
      if (process.platform !== "win32" && (fsSync.fstatSync(retained.fd).mode & 0o444) !== 0o444) {
        throw error;
      }
    }
    if (params.durable) {
      params.scope.assertCurrent();
      assertRequestedDirectory();
      assertMediaDirectory();
      assertOwnedFile(temporaryPath);
      await retained.sync();
    }
    params.scope.assertCurrent();
    assertRequestedDirectory();
    assertMediaDirectory();
    assertOwnedFile(temporaryPath);
    finalId = result.id;
    await mediaRoot.move(temporaryName, finalId, {
      overwrite: false,
      assertBeforeMutation: () => {
        params.scope.assertCurrent();
        assertRequestedDirectory();
        assertMediaDirectory();
        assertOwnedFile?.(temporaryPath);
        // Repeat the move owner's collision check after its awaited preparation.
        try {
          fsSync.lstatSync(path.join(mediaRoot.rootReal, result.id));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return;
          }
          throw error;
        }
        throw new FsSafeError("already-exists", "Media output already exists");
      },
    });
    resource.assertCurrent();
    if (params.durable) {
      params.scope.assertCurrent();
      await syncDirectoryBestEffort(mediaRoot.rootReal);
      params.scope.assertCurrent();
      resource.assertCurrent();
    }
    params.scope.registerResource(resource);
    handedOff = true;
    return result;
  } catch (error) {
    // Also covers publication that completed before a failed post-check, and
    // an already-issued move settling after its enclosing scope closed.
    await settleChannelReadResource(resource, false);
    throw error;
  } finally {
    if (!handedOff) {
      await settleChannelReadResource(resource, false);
    }
  }
}
