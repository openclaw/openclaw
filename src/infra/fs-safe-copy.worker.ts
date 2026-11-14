import { readFileSync, rmSync } from "node:fs";
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
import type {
  FsSafeCopyRead,
  FsSafeCopyReply,
  FsSafeCopyWrite,
  FsSafeProvisionCopy,
} from "./fs-safe-copy-worker-contract.js";
import { normalizeFsSafeNativeEnv } from "./fs-safe-env.js";

function failure(error: unknown): FsSafeCopyReply {
  return {
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

normalizeFsSafeNativeEnv();

if (parentPort) {
  // This isolate uses the library's default and explicit operator environment.
  // Shared worker plumbing may load Gateway defaults; keep those in the host.
  const nativeConfig = getFsSafeNativeConfig();
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  configureFsSafeNative(nativeConfig);
  serveWorkerTasks<FsSafeCopyReply, FsSafeCopyRead | FsSafeProvisionCopy>(
    async (command, channel, control) => {
      try {
        switch (command.type) {
          case "provision": {
            if (!channel) {
              throw new Error("Worktree provisioning requires its live host channel");
            }
            const decision = new Int32Array(command.decision);
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
                    signal: control.signal,
                    assertCurrent: () => {
                      control.throwIfCancelled();
                      Atomics.store(decision, 0, 0);
                      channel.notify("authority");
                      while (Atomics.load(decision, 0) === 0) {
                        // Retirement can suppress notifications. Observe its shared
                        // cancellation fence even while this callback cannot yield.
                        Atomics.wait(decision, 0, 0, 1_000);
                        control.throwIfCancelled();
                      }
                      control.throwIfCancelled();
                      if (Atomics.load(decision, 0) !== 1) {
                        throw new Error("Worktree provisioning mutation authority refused");
                      }
                    },
                  },
                ),
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
        return failure(error);
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
        rmSync(command.destination, { recursive: true, force: true });
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
