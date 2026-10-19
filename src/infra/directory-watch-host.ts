import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

type Listener = (event: string, filename?: string) => void;
export type DirectoryWatch = {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};
type Host = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  watches: Map<number, EventEmitter>;
};

// libuv on macOS rebuilds the loop's shared FSEventStream synchronously on every
// directory-watch close, waiting on fseventsd; under load one close can block for
// seconds, and Node's exit cleanup closes leftover watchers the same way. A helper
// process owns those streams so the caller's loop never closes one, and the helper
// exits without closing them once its input ends.
const HOST_SCRIPT = `
const fs = require("node:fs");
const watches = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffered = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  const lines = (buffered + chunk).split("\\n");
  buffered = lines.pop();
  for (const line of lines) {
    const { id, path, recursive } = JSON.parse(line);
    if (path === undefined) {
      watches.get(id)?.close();
      watches.delete(id);
      continue;
    }
    try {
      const watcher = fs.watch(path, { persistent: false, recursive }, (event, filename) =>
        send({ id, event, filename }),
      );
      watcher.on("error", () => {
        watches.delete(id);
        send({ id });
      });
      watches.set(id, watcher);
      // Registration is asynchronous; invalidate once live to cover the startup gap.
      send({ id, event: "change" });
    } catch {
      send({ id });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let host: Host | undefined;
let nextId = 0;

function startHost(): Host {
  const child = spawn(process.execPath, ["-e", HOST_SCRIPT], {
    stdio: ["pipe", "pipe", "ignore"],
    // Terminal signals reach the caller first; the helper exits when its input ends.
    detached: true,
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const started: Host = { child, watches: new Map() };
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      // SAFETY: HOST_SCRIPT is the only writer and sends exactly this shape.
      const message = JSON.parse(line) as { id: number; event?: string; filename?: string | null };
      const watch = started.watches.get(message.id);
      if (!watch) {
        continue;
      }
      if (message.event) {
        watch.emit("change", message.event, message.filename ?? undefined);
      } else {
        started.watches.delete(message.id);
        watch.emit("error", new Error("Directory watch host lost the watch"));
      }
    }
  });
  const lost = () => {
    if (host === started) {
      host = undefined;
    }
    const watches = Array.from(started.watches.values());
    started.watches.clear();
    for (const watch of watches) {
      watch.emit("error", new Error("Directory watch host exited"));
    }
  };
  child.on("error", lost).on("exit", lost);
  child.stdin.on("error", () => {});
  child.unref();
  for (const stream of [child.stdin, child.stdout]) {
    // SAFETY: stdio "pipe" streams are net.Socket instances, which own unref().
    (stream as Partial<{ unref(): void }>).unref?.();
  }
  return started;
}

function watchInHost(
  directoryPath: string,
  listener: Listener,
  recursive: boolean,
): DirectoryWatch {
  // Match fs.watch's synchronous admission so callers can fall back to an ancestor.
  fs.closeSync(fs.openSync(directoryPath, "r"));
  const current = (host ??= startHost());
  const id = nextId++;
  const watch = new EventEmitter();
  watch.on("change", listener);
  current.watches.set(id, watch);
  current.child.stdin.write(`${JSON.stringify({ id, path: directoryPath, recursive })}\n`);
  return Object.assign(watch, {
    close() {
      watch.removeAllListeners("change");
      if (!current.watches.delete(id)) {
        return;
      }
      if (current.watches.size) {
        current.child.stdin.write(`${JSON.stringify({ id })}\n`);
      } else {
        if (host === current) {
          host = undefined;
        }
        current.child.stdin.end();
      }
    },
  });
}

/** Non-persistent native directory watch whose teardown never waits on FSEvents. */
export function watchDirectory(
  directoryPath: string,
  listener: Listener,
  recursive = false,
): DirectoryWatch {
  return process.platform === "darwin" && !process.versions.bun
    ? watchInHost(directoryPath, listener, recursive)
    : fs.watch(directoryPath, { persistent: false, recursive }, (event, filename) =>
        listener(event, filename?.toString() ?? undefined),
      );
}
