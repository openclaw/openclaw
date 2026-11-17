import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync } from "node:fs";
import type { Socket } from "node:net";
import { releaseProcessStdin } from "../release-stdin.js";
import type { SpawnStdioEntry } from "../spawn-secret-input.js";
import type { ServiceChildStart } from "./service-child-protocol.js";
import { reserveStdioEntry, setStdioEntry } from "./service-child-stdio.js";

export function commandStdio(start: ServiceChildStart) {
  const stdio: SpawnStdioEntry[] = [
    start.stdinMode === "inherit" ? "inherit" : "pipe",
    "pipe",
    "pipe",
  ];
  if (start.secretFd !== undefined) {
    setStdioEntry(stdio, start.secretFd, start.secretFd);
  }
  const lineageFd = reserveStdioEntry(stdio, start.lineageFd ?? "pipe");
  const inheritedLineageFds = [
    lineageFd,
    ...(start.parentLineageFds ?? []).map((fd) => reserveStdioEntry(stdio, fd)),
  ];
  if (start.ownedWorker) {
    stdio.push("ipc");
  }
  return { stdio, lineageFd, inheritedLineageFds };
}

export function delay(ms: number, retainOwner = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!retainOwner) {
      timer.unref?.();
    }
  });
}

/**
 * Stop relaying a handed-off command's output, but keep draining it until every
 * holder closes it: a handed-off service must never fail on a broken stdout or stderr.
 */
export function releaseCommandOutput(
  command: ChildProcess,
  streams: Iterable<"stdout" | "stderr">,
): Promise<void> {
  return Promise.all(
    [...streams].map(async (stream) => {
      const source = command[stream];
      if (!source) {
        return;
      }
      source.unpipe(process[stream]);
      // The host reads what was already relayed up to this EOF; nothing more follows.
      process[stream].end();
      const closed = once(source, "close").catch(() => undefined);
      source.resume();
      await closed;
    }),
  ).then(() => undefined);
}

/** Flush the anchor's last receipt, then release every host channel. */
export function finishAnchorTransport(control: Socket | undefined, code: number): void {
  process.exitCode = code;
  releaseProcessStdin();
  const disconnect = () => {
    // end() flushes the receipt; destroy() also releases the readable socket.
    control?.off("close", disconnect);
    control?.destroy();
    if (process.connected) {
      process.disconnect?.();
    }
  };
  if (control && !control.destroyed) {
    control.once("close", disconnect);
    control.end(disconnect);
  } else {
    disconnect();
  }
}

/** Close inherited descriptors once, ignoring duplicates. */
export function closeFds(fds: readonly number[] | undefined): void {
  for (const fd of new Set(fds ?? [])) {
    closeSync(fd);
  }
}
