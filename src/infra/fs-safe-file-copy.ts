import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { Root, RootCopyOptions, RootCopySource } from "@openclaw/fs-safe/root";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasNodeErrorCode } from "./path-guards.js";

const log = createSubsystemLogger("infra/file-copy");

function isCloneUnavailable(error: unknown): boolean {
  if (!(error instanceof FsSafeError)) {
    return false;
  }
  if (
    error.code === "unsupported-platform" ||
    (error.code === "helper-unavailable" && error.message === "native file cloning is unavailable")
  ) {
    return true;
  }
  // fs-safe 0.23 reports the failed syscall only in the direct native cause.
  // Generic EPERM (open/chmod/publication) and failed cleanup (EIO) must stay fatal.
  return (
    error.code === "helper-failed" &&
    error.cause instanceof Error &&
    error.cause.message.startsWith("FICLONE:") &&
    ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].some((code) =>
      hasNodeErrorCode(error.cause, code),
    )
  );
}

/** One copy operation keeps native guards and warns once when cloning is unavailable. */
export function createFileCopyWithCloneFallback() {
  let byteCopy = false;
  return async (
    root: Pick<Root, "copyIn">,
    relativePath: string,
    source: RootCopySource,
    options: Omit<RootCopyOptions, "clone">,
    beforeByteCopy?: () => void | Promise<void>,
  ): Promise<void> => {
    if (byteCopy) {
      await beforeByteCopy?.();
      await root.copyIn(relativePath, source, { ...options, clone: "never" });
      return;
    }
    let published = false;
    try {
      await root.copyIn(relativePath, source, {
        ...options,
        clone: beforeByteCopy ? "always" : "auto",
        onDestinationPublished: (receipt) => {
          published = true;
          return options.onDestinationPublished?.(receipt);
        },
      });
    } catch (error) {
      if (published || !isCloneUnavailable(error)) {
        throw error;
      }
      if (!byteCopy) {
        byteCopy = true;
        log.warn("File cloning is unavailable; continuing with a guarded byte copy.");
      }
      await beforeByteCopy?.();
      // Re-enter the same guarded owner with the original admission and publication checks.
      await root.copyIn(relativePath, source, { ...options, clone: "never" });
    }
  };
}
