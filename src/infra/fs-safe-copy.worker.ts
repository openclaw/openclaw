import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { serialize } from "node:v8";
import { parentPort } from "node:worker_threads";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import {
  copyTree,
  createCloneSource,
  probeTreeClone,
  readCloneFileMetadata,
} from "@openclaw/fs-safe/copy";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
import { fileStore } from "@openclaw/fs-safe/store";
import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
} from "../agents/workspace-filesystem.types.js";
import { hasErrnoCode } from "./errno.js";
import type {
  FsSafeCopyRead,
  FsSafeCopyReply,
  FsSafeCopyWrite,
  FsSafeStoreCommand,
  FsSafeProvisionCopy,
  ProvisionCopyDetails,
} from "./fs-safe-copy-worker-contract.js";
import { normalizeFsSafeNativeEnv } from "./fs-safe-env.js";
import type { ScratchTreeRequest } from "./scratch-cleanup-tree.js";
import { encodeNativeWorkerFailure } from "./worker-native-error.js";

async function cloneRefsDirectory(
  source: string,
  destination: string,
  options: { signal?: AbortSignal; assertCurrent: () => void },
  openRoot: typeof import("@openclaw/fs-safe/root").root,
): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isDirectory()) {
    throw new Error(`Worktree template is not a directory: ${source}`);
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  options.assertCurrent();
  await fs.mkdir(destination, { mode: 0o700 });
  const destinationRoot = await openRoot(destination);
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneRefsDirectory(sourcePath, destinationPath, options, openRoot);
    } else {
      options.assertCurrent();
      await destinationRoot.copyIn(entry.name, sourcePath, {
        clone: "always",
        overwrite: false,
        mkdir: false,
        durable: false,
        maxBytes: Infinity,
        preserveSourceMode: true,
        preserveMetadata: true,
        sourceSymlinks: "copy-link",
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        signal: options.signal,
        assertBeforeMutation: options.assertCurrent,
      });
      options.assertCurrent();
      // Let cancellation and allocation-lease renewal run between native file clones.
      await setImmediate();
    }
  }
  // Populate writable directories before restoring their source permissions.
  options.assertCurrent();
  await fs.chmod(destination, stats.mode & 0o777);
}

function failure(error: unknown): FsSafeCopyReply {
  return {
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof FsSafeError ? { fsSafeCode: error.code } : {}),
    ...(error instanceof Error && error.cause !== undefined
      ? { cause: encodeNativeWorkerFailure(error.cause) }
      : {}),
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
  const { assertSandboxStateOwnerPathCurrent } =
    await import("../agents/sandbox/state-owner-path.js");
  const { assertWorkspaceFilesystemEvidence } = await import("../agents/workspace-state-guard.js");
  const { withWorkerFsSafeNativeMode } = await import("./worker-fs-safe.js");
  const { workerMutationAssertion } = await import("./worker-mutation-authority.js");
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  configureFsSafeNative(nativeConfig);
  serveWorkerTasks<
    FsSafeCopyReply,
    | FsSafeCopyRead
    | FsSafeProvisionCopy
    | WorkspaceFilesystemCommand
    | WorkspaceFilesystemReadCommand
    | FsSafeStoreCommand
    | ScratchTreeRequest
  >(async (command, channel, control) => {
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
        case "prune-store":
        case "remove-store-file":
          return await control.runNativeSection<FsSafeCopyReply>(() =>
            withWorkerFsSafeNativeMode(command.nativeMode, async () => {
              const store = fileStore({ rootDir: command.rootDir, dirMode: 0o700, mode: 0o600 });
              if (command.type === "prune-store") {
                await store.pruneExpired(command.options);
              } else {
                await store.remove(command.relativePath);
              }
              return { type: "written" };
            }),
          );
        case "workspace-read":
          return await control.runNativeSection(async () => {
            const { executeWorkspaceFilesystemRead } =
              await import("../agents/workspace-filesystem.worker.js");
            return withWorkerFsSafeNativeMode(command.nativeMode, () =>
              executeWorkspaceFilesystemRead(command),
            );
          });
        case "workspace": {
          if (!channel) {
            throw new Error("Workspace filesystem requires its live host channel");
          }
          const assertCurrent = workerMutationAssertion(
            command.decision,
            () => channel.notify("authority"),
            control.throwIfCancelled,
          );
          return await control.runNativeSection(async () => {
            const { executeWorkspaceFilesystemOperation } =
              await import("../agents/workspace-filesystem.worker.js");
            return withWorkerFsSafeNativeMode(command.nativeMode, () =>
              executeWorkspaceFilesystemOperation(command, assertCurrent),
            );
          });
        }
        case "refs-copy":
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
            const assertCurrent = () => {
              const started = performance.now();
              details.authorityChecks++;
              try {
                for (const evidence of command.workspaceEvidence ?? []) {
                  assertWorkspaceFilesystemEvidence(evidence);
                }
                if (command.stateOwnerPath) {
                  assertSandboxStateOwnerPathCurrent(command.stateOwnerPath);
                }
                assertMutation();
              } finally {
                details.authorityMs += performance.now() - started;
              }
            };
            if (command.type === "refs-copy") {
              await withWorkerFsSafeNativeMode(command.nativeMode, async () => {
                const { root } = await import("@openclaw/fs-safe/root");
                await cloneRefsDirectory(
                  command.source,
                  command.destination,
                  { signal: control.signal, assertCurrent },
                  root,
                );
              });
              return { type: "written", workspaceEvidence: command.workspaceEvidence };
            }
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
                  assertCurrent,
                },
              ),
              copyDetails: details,
              workspaceEvidence: command.workspaceEvidence,
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
      if (command.type === "workspace-read") {
        return {
          type: "workspace-read",
          result: {
            ok: false,
            reason: error instanceof RangeError ? "validation" : "io",
            error: encodeNativeWorkerFailure(error),
            ...(error instanceof FsSafeError ? { fsCode: error.code, details: error.details } : {}),
          },
        };
      }
      if (command.type === "workspace") {
        return { type: "workspace-failed", error: encodeNativeWorkerFailure(error) };
      }
      return { ...failure(error), ...(copyDetails ? { copyDetails } : {}) };
    }
  });
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  let reply: FsSafeCopyReply = { type: "written" };
  try {
    // SAFETY: This private process receives only the host's typed filesystem commands.
    const command = JSON.parse(readFileSync(0, "utf8")) as FsSafeCopyWrite;
    switch (command.type) {
      case "reclaim-plugin-captures": {
        const { reclaimPluginCaptureBatch } =
          await import("../plugins/plugin-source-capture-native-loads.js");
        reply = {
          type: "captures-reclaimed",
          ...(await reclaimPluginCaptureBatch(command.candidates)),
        };
        break;
      }
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
  } catch (error) {
    reply = failure(error);
  } finally {
    process.off("SIGTERM", abort);
  }
  process.stdout.write(serialize(reply));
}
