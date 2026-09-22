import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream } from "node:fs";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import type {
  ServiceChildControlMessage,
  ServiceChildRelayMessage,
  ServiceChildStart,
} from "./service-child-protocol.js";

type StdioEntry = "ignore" | "inherit" | "ipc" | number;

function reserveIpcFd(stdio: StdioEntry[]): void {
  let fd = 3;
  while (stdio[fd] !== undefined && stdio[fd] !== "ignore") {
    fd += 1;
  }
  while (stdio.length <= fd) {
    stdio.push("ignore");
  }
  stdio[fd] = "ipc";
}

function runServiceChildRelay(): void {
  let generation: string | undefined;
  let anchor: ChildProcess | undefined;
  let parentLost = false;
  let forcedSequence: number | undefined;
  let signalError: string | undefined;
  let anchorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

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
  const notifyParentLoss = () => {
    if (parentLost) {
      return;
    }
    parentLost = true;
    if (anchorExit) {
      process.exit(anchorExit.code === 0 || anchorExit.signal === "SIGKILL" ? 0 : 1);
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
    const anchorUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor);
    const stdio: StdioEntry[] = ["inherit", "inherit", "inherit"];
    while (stdio.length <= start.controlFd) {
      stdio.push("ignore");
    }
    stdio[start.controlFd] = start.controlFd;
    if (start.lineageFd !== undefined) {
      while (stdio.length <= start.lineageFd) {
        stdio.push("ignore");
      }
      stdio[start.lineageFd] = start.lineageFd;
    }
    if (start.secretFd !== undefined) {
      while (stdio.length <= start.secretFd) {
        stdio.push("ignore");
      }
      stdio[start.secretFd] = start.secretFd;
    }
    reserveIpcFd(stdio);
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
      if (forcedSequence !== undefined && !parentLost && process.connected) {
        // Keep the reaper alive until the host receives the exit fact and releases its handle.
        reportRetirement();
      } else {
        process.exit(code === 0 || signal === "SIGKILL" ? 0 : 1);
      }
    });
  });
}

runServiceChildRelay();
