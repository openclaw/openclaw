import { closeSync } from "node:fs";
import type { Socket } from "node:net";
import { PassThrough, pipeline, type Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
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

/** Relay owned output, returning a handoff that drains without breaking its writer. */
export function relayCommandOutput(
  source: Readable,
  destination: Writable,
  settled: () => void,
): () => Promise<void> {
  // The source cannot be in pipeline: ending the host output during handoff
  // would destroy the child's pipe, even after unpipe(), and break later writes.
  const relay = new PassThrough();
  let released = false;
  source.once("error", (error) => relay.destroy(error));
  relay.once("close", () => {
    if (!released) {
      source.destroy();
    }
  });
  pipeline(relay, destination, settled);
  source.pipe(relay);
  return async () => {
    released = true;
    source.unpipe(relay);
    // Flush the relayed tail to host EOF, then discard future service output.
    relay.end();
    const drained = finished(source, { cleanup: true }).catch(() => undefined);
    source.resume();
    await drained;
  };
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
