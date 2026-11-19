import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";

type Listener = (event: string, filename?: string) => void;
export type DirectoryWatch = {
  close(): void;
  on(event: "error", listener: (error: Error, pathUnavailable: boolean) => void): unknown;
};
type HostedWatch = EventEmitter & { path: string; recursive: boolean };
type Host = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  watches: Map<number, HostedWatch>;
  retired: number;
};

// Node recursive Linux watches synchronously scan and stat their trees on changes.
// The same helper also isolates native watch admission on every platform.
// libuv on macOS rebuilds the loop's shared FSEventStream synchronously on every
// directory-watch close, waiting on fseventsd; under load one close can block for
// seconds, and Node's exit cleanup closes leftover watchers the same way. A helper
// process owns those streams and never closes one on macOS: a close only retires
// its id, and the helper exits without teardown once its input ends.

let host: Host | undefined;
let nextId = 0;
// Retired native watches stay open until their helper exits; past this many the
// live watches move to a fresh helper, whose single stream build replaces one
// rebuild per close.
const MAX_RETIRED_WATCHES = 64;

function startHost(): Host {
  // The caller passes its PID so a helper that starts after it died still exits.
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("directoryWatchHost")),
      String(process.pid),
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      // Terminal signals reach the caller first; the helper exits when its input ends
      // or its caller is gone.
      detached: true,
      env: { ...process.env, NODE_OPTIONS: undefined },
    },
  );
  const started: Host = { child, watches: new Map(), retired: 0 };
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      // SAFETY: The dedicated host entry is the only writer and sends this shape.
      const message = JSON.parse(line) as { id: number; event?: string; filename?: string | null };
      const watch = started.watches.get(message.id);
      if (!watch) {
        continue;
      }
      if (message.event) {
        watch.emit("change", message.event, message.filename ?? undefined);
      } else {
        started.watches.delete(message.id);
        watch.emit("error", new Error("Directory watch host lost the watch"), true);
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
      watch.emit("error", new Error("Directory watch host exited"), false);
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

function register(target: Host, id: number, watch: HostedWatch): void {
  target.watches.set(id, watch);
  target.child.stdin.write(
    `${JSON.stringify({ id, path: watch.path, recursive: watch.recursive })}\n`,
  );
}

/** Non-persistent native directory watch whose teardown never waits on FSEvents. */
export function watchDirectory(
  directoryPath: string,
  listener: Listener,
  recursive = false,
): DirectoryWatch {
  const id = nextId++;
  const watch = Object.assign(new EventEmitter(), { path: directoryPath, recursive });
  watch.on("change", listener);
  try {
    register((host ??= startHost()), id, watch);
  } catch (error) {
    host?.watches.delete(id);
    queueMicrotask(() => watch.emit("error", error, false));
  }
  return Object.assign(watch, {
    close() {
      watch.removeAllListeners("change");
      // Live watches always sit in the current helper; a lost one is in none.
      const current = host;
      if (!current?.watches.delete(id)) {
        return;
      }
      if (
        current.watches.size &&
        (process.platform !== "darwin" || ++current.retired < MAX_RETIRED_WATCHES)
      ) {
        current.child.stdin.write(`${JSON.stringify({ id })}\n`);
        return;
      }
      host = undefined;
      if (current.watches.size) {
        // Each moved watch invalidates once when live again, covering the handoff.
        const next = (host = startHost());
        for (const [movedId, moved] of current.watches) {
          register(next, movedId, moved);
        }
        current.watches.clear();
      }
      current.child.stdin.end();
    },
  });
}
