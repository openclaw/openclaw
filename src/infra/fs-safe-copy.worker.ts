import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { serialize } from "node:v8";
import { parentPort } from "node:worker_threads";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import {
  copyTree,
  createCloneSource,
  probeTreeClone,
  readCloneFileMetadata,
} from "@openclaw/fs-safe/copy";
import { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
import { hasErrnoCode } from "./errno.js";
import type {
  FsSafeCopyRead,
  FsSafeCopyReply,
  FsSafeCopyWrite,
  FsSafeProvisionCopy,
  ProvisionCopyDetails,
} from "./fs-safe-copy-worker-contract.js";
import { normalizeFsSafeNativeEnv } from "./fs-safe-env.js";
import type { ScratchTreeRequest } from "./scratch-cleanup-tree.js";
import { workerMutationAssertion } from "./worker-mutation-authority.js";

function failure(error: unknown): FsSafeCopyReply {
  return {
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

function prepareOwnedDirectoryRemoval(directory: string): void {
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    return;
  }
  // Retired templates and captures have no writers. Repair their directories,
  // including excluded outputs, without changing files or following symlinks.
  if ((stats.mode & 0o700) !== 0o700) {
    chmodSync(directory, (stats.mode & 0o7777) | 0o700);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      prepareOwnedDirectoryRemoval(path.join(directory, entry.name));
    }
  }
}

normalizeFsSafeNativeEnv();

if (parentPort) {
  // This isolate uses the library's default and explicit operator environment.
  // Shared worker plumbing may load Gateway defaults; keep those in the host.
  const nativeConfig = getFsSafeNativeConfig();
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  configureFsSafeNative(nativeConfig);
  serveWorkerTasks<FsSafeCopyReply, FsSafeCopyRead | FsSafeProvisionCopy | ScratchTreeRequest>(
    async (command, channel, control) => {
      let copyDetails: ProvisionCopyDetails | undefined;
      try {
        switch (command.type) {
          case "scratch": {
            if (!channel) {
              throw new Error("Scratch cleanup requires its live host channel");
            }
            const { walkScratchTree } = await import("./scratch-cleanup-tree.js");
            let progress: import("./scratch-cleanup-tree.js").ScratchTreeResult;
            const checkpoint = workerMutationAssertion(
              command.decision,
              () => channel.notify(progress),
              control.throwIfCancelled,
            );
            return await control.runNativeSection(() =>
              walkScratchTree(command, control.throwIfCancelled, async (next) => {
                progress = next;
                checkpoint();
              }),
            );
          }
          case "provision": {
            copyDetails = {
              copier: "portable",
              batchCount: 0,
              sourceBytes: 0,
              spawnCount: 0,
              spawnMs: 0,
              childMs: 0,
              authorityChecks: 0,
              authorityMs: 0,
            };
            const details = copyDetails;
            if (!channel) {
              throw new Error("Worktree provisioning requires its live host channel");
            }
            const assertMutation = workerMutationAssertion(
              command.decision,
              () => channel.notify("authority"),
              control.throwIfCancelled,
            );
            return await control.runNativeSection<FsSafeCopyReply>(async () => {
              const { copyProvisionedPaths } =
                await import("../agents/worktrees/provisioned-copy.js");
              return {
                type: "provisioned",
                paths: await copyProvisionedPaths(
                  command.source,
                  command.destination,
                  command.paths,
                  {
                    copyDetails: details,
                    signal: control.signal,
                    assertCurrent: () => {
                      const started = performance.now();
                      details.authorityChecks++;
                      try {
                        assertMutation();
                      } finally {
                        details.authorityMs += performance.now() - started;
                      }
                    },
                  },
                ),
                copyDetails: details,
              };
            });
          }
          case "probe":
            return {
              type: "probe",
              backend: probeTreeClone(command.parent),
              nativeMode: getFsSafeNativeConfig().mode,
            };
          case "acl":
            return { type: "acl", acl: inspectDarwinAcl(command.path) };
          case "metadata":
            return { type: "metadata", entries: await readCloneFileMetadata(command.paths) };
          default:
            throw new Error("Unknown native worktree read operation");
        }
      } catch (error) {
        return { ...failure(error), ...(copyDetails ? { copyDetails } : {}) };
      }
    },
  );
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  let reply: FsSafeCopyReply;
  try {
    // SAFETY: The host sends its typed write command only after the live input guard succeeds.
    const command = JSON.parse(readFileSync(0, "utf8")) as FsSafeCopyWrite;
    switch (command.type) {
      case "remove":
        // Node's synchronous remover walks natively, outside the Gateway's JS heap.
        try {
          rmSync(command.destination, { recursive: true, force: true });
        } catch (error) {
          if (
            !hasErrnoCode(error, "EACCES") &&
            !hasErrnoCode(error, "EPERM") &&
            !hasErrnoCode(error, "ENOTEMPTY")
          ) {
            throw error;
          }
          prepareOwnedDirectoryRemoval(command.destination);
          rmSync(command.destination, { recursive: true, force: true });
        }
        break;
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
