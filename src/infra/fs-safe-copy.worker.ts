import { readFileSync } from "node:fs";
import { serialize } from "node:v8";
import { parentPort } from "node:worker_threads";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import {
  copyTree,
  createCloneSource,
  probeTreeClone,
  readCloneFileMetadata,
} from "@openclaw/fs-safe/copy";
import type {
  FsSafeCopyRead,
  FsSafeCopyReply,
  FsSafeCopyWrite,
} from "./fs-safe-copy-worker-contract.js";

function failure(error: unknown): FsSafeCopyReply {
  return {
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

if (parentPort) {
  // This isolate uses the library's default and explicit operator environment.
  // Shared worker plumbing may load Gateway defaults; keep those in the host.
  const nativeConfig = getFsSafeNativeConfig();
  const { serveWorkerTasks } = await import("./worker-task-pool.js");
  configureFsSafeNative(nativeConfig);
  serveWorkerTasks<FsSafeCopyReply>(async (input) => {
    // SAFETY: The private worker receives only the host's typed read operations.
    const command = input as FsSafeCopyRead;
    try {
      switch (command.type) {
        case "probe":
          return { type: "probe", backend: probeTreeClone(command.parent) };
        case "metadata":
          return { type: "metadata", entries: await readCloneFileMetadata(command.paths) };
        default:
          throw new Error("Unknown native worktree read operation");
      }
    } catch (error) {
      return failure(error);
    }
  });
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  let reply: FsSafeCopyReply;
  try {
    // SAFETY: The host sends its typed write command only after the live input guard succeeds.
    const command = JSON.parse(readFileSync(0, "utf8")) as FsSafeCopyWrite;
    switch (command.type) {
      case "create":
        await createCloneSource(command.destination, { signal: controller.signal });
        break;
      case "copy":
        await copyTree(command.source, command.destination, {
          clone: "always",
          signal: controller.signal,
        });
        break;
      default:
        throw new Error("Unknown native worktree operation");
    }
    reply = { type: "written" };
  } catch (error) {
    reply = failure(error);
  } finally {
    process.off("SIGTERM", abort);
  }
  process.stdout.write(serialize(reply));
}
