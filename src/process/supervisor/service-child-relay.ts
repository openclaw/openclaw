import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import type { SpawnStdioEntry } from "../spawn-secret-input.js";
import { isOwnedProcessGroupGone } from "./service-child-group-ownership.js";
import type {
  ServiceChildControlMessage,
  ServiceChildRelayMessage,
  ServiceChildStart,
} from "./service-child-protocol.js";
import { reserveStdioEntry, setStdioEntry } from "./service-child-stdio.js";

declare const WORKER_DEPLOY_BUILD: boolean;

if (typeof WORKER_DEPLOY_BUILD === "boolean" && WORKER_DEPLOY_BUILD) {
  registerSealedRuntimeProcessEntrypoint(
    "serviceChildGroupAnchor",
    new URL("./service-child-group-anchor.mjs", import.meta.url),
  );
}

function runServiceChildRelay(): void {
  let generation: string | undefined;
  let anchor: ChildProcess | undefined;
  let parentLost = false;
  let forcedSequence: number | undefined;
  let signalError: string | undefined;
  let anchorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let parentLineageFds: number[] = [];
  let parentLineageReleased = false;

  const report = (message: ServiceChildRelayMessage) => {
    if (!process.connected) {
      return;
    }
    try {
      process.send?.(message, () => {});
    } catch {
      // Disconnect owns parent loss; failed reporting must not abandon anchor reaping.
    }
  };
  const reportRetirement = () => {
    if (generation && forcedSequence !== undefined) {
      report({
        type: "retirement",
        generation,
        sequence: forcedSequence,
        anchorExited: anchorExit !== undefined,
        signalError,
      });
    }
  };
  const settleAnchorExit = () => {
    if (!anchorExit || !parentLineageReleased) {
      return;
    }
    if (forcedSequence !== undefined && !parentLost && process.connected) {
      // Preserve the current host's retirement receipt until it releases this handle.
      reportRetirement();
    } else {
      process.exit(anchorExit.code === 0 || anchorExit.signal === "SIGKILL" ? 0 : 1);
    }
  };
  const releaseParentLineage = async () => {
    if (parentLineageFds.length > 0) {
      let reportedFailure = false;
      for (;;) {
        try {
          if (isOwnedProcessGroupGone(anchor!.pid!)) {
            break;
          }
        } catch (error) {
          if (!reportedFailure) {
            reportedFailure = true;
            report({
              type: "relay-error",
              generation: generation!,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await delay(100);
      }
      // These writers belong to the enclosing worker. They do not include this
      // relay's own lineage, and close before waiting for its retirement receipt.
      for (const fd of parentLineageFds) {
        closeSync(fd);
      }
      parentLineageFds = [];
    }
    parentLineageReleased = true;
    settleAnchorExit();
  };
  const notifyParentLoss = () => {
    if (parentLost) {
      return;
    }
    parentLost = true;
    if (anchorExit) {
      settleAnchorExit();
      return;
    }
    if (anchor?.connected) {
      anchor.send({ type: "parent-loss", generation });
    }
  };

  process.once("disconnect", notifyParentLoss);
  process.once("SIGTERM", notifyParentLoss);
  process.once("SIGINT", notifyParentLoss);
  process.on("message", (raw: unknown) => {
    // SAFETY: the spawned host is the sole sender on this private IPC channel.
    const start = raw as ServiceChildStart | ServiceChildControlMessage;
    if (start?.type === "cancel") {
      if (
        !generation ||
        !anchor ||
        start.generation !== generation ||
        start.signal !== "SIGKILL" ||
        !Number.isSafeInteger(start.sequence) ||
        start.sequence <= 0 ||
        forcedSequence !== undefined
      ) {
        return;
      }
      forcedSequence = start.sequence;
      if (!anchorExit) {
        try {
          if (!anchor.kill("SIGKILL")) {
            signalError ??= "retained anchor SIGKILL was not delivered";
          }
        } catch (error) {
          signalError = error instanceof Error ? error.message : String(error);
        }
      }
      reportRetirement();
      return;
    }
    if (generation) {
      return;
    }
    if (!start || start.type !== "start" || !start.generation) {
      process.exitCode = 1;
      return;
    }
    generation = start.generation;
    if (start.controlFd === undefined) {
      report({ type: "relay-error", generation, error: "service child control fd is missing" });
      process.exitCode = 1;
      return;
    }
    const anchorUrl = resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor");
    const stdio: SpawnStdioEntry[] = ["inherit", "inherit", "inherit"];
    parentLineageFds = start.parentLineageFds ?? [];
    for (const fd of [start.controlFd, start.lineageFd, ...parentLineageFds, start.secretFd]) {
      if (fd !== undefined) {
        setStdioEntry(stdio, fd, fd);
      }
    }
    reserveStdioEntry(stdio, "ipc");
    try {
      anchor = spawn(process.execPath, resolveRuntimeWorkerArgv(anchorUrl), {
        stdio,
        detached: true,
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      report({
        type: "relay-error",
        generation,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      return;
    }
    if (!anchor.connected) {
      report({ type: "relay-error", generation, error: "anchor lifecycle IPC was not created" });
      anchor.kill("SIGKILL");
      process.exitCode = 1;
      return;
    }
    anchor.once("spawn", () => {
      closeSync(start.controlFd!);
      // Only the anchor and command may retain the host's lineage writer.
      if (start.lineageFd !== undefined) {
        closeSync(start.lineageFd);
      }
      // The anchor inherited these outputs. Close only the relay's duplicate writers
      // so output EOF does not depend on either process giving up cleanup authority.
      if (process.versions.bun) {
        for (const fd of [1, 2]) {
          const output = createWriteStream("", { fd, autoClose: true });
          output.once("error", (error) => {
            report({ type: "relay-error", generation: start.generation, error: error.message });
            notifyParentLoss();
          });
          output.end();
        }
      } else {
        process.stdout.destroy();
        process.stderr.destroy();
      }
      anchor?.send(start);
      if (parentLost) {
        anchor?.send({ type: "parent-loss", generation });
      }
    });
    anchor.once("error", (error) => {
      if (forcedSequence !== undefined) {
        signalError = error.message;
        reportRetirement();
      } else {
        report({ type: "relay-error", generation: generation!, error: error.message });
      }
    });
    anchor.once("exit", (code, signal) => {
      anchorExit = { code, signal };
      void releaseParentLineage().catch((error: unknown) => {
        report({
          type: "relay-error",
          generation: generation!,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  });
}

runServiceChildRelay();
