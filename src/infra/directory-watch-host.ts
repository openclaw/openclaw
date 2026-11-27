import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  raiseChildOomScoreInBackground,
  shouldAdjustChildOomScore,
} from "../process/linux-oom-score-spawn.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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

type WatchRequest = { id: number; path: string; recursive: boolean } | { id: number };
type WatchReply =
  | { id: number; event: string; filename?: string }
  | { id: number; error: Error; pathUnavailable: boolean };

const state = resolveGlobalSingleton<{
  host?: Host;
  nextId: number;
  remote?: (path: string, listener: Listener, recursive: boolean) => DirectoryWatch;
}>(Symbol.for("openclaw.directoryWatchHost"), () => ({ nextId: 0 }));
// Retired native watches stay open until their helper exits; past this many the
// live watches move to a fresh helper, whose single stream build replaces one
// rebuild per close.
const MAX_RETIRED_WATCHES = 64;

function reportWatchError(
  host: Host | undefined,
  watch: HostedWatch,
  error: unknown,
  pathUnavailable: boolean,
) {
  try {
    watch.emit("error", error, pathUnavailable);
  } finally {
    // An error handler may immediately watch the nearest parent on this helper.
    if (host && state.host === host && !host.watches.size) {
      state.host = undefined;
      host.child.stdin.end();
    }
  }
}

function startHost(): Host {
  const env = { ...process.env, NODE_OPTIONS: undefined };
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
      env,
    },
  );
  // Under memory pressure the kernel should end this recoverable helper, not its caller:
  // lost watches fall back to scans and the next watch starts a fresh helper.
  if (shouldAdjustChildOomScore({ env })) {
    raiseChildOomScoreInBackground(child.pid);
  }
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
        reportWatchError(started, watch, new Error("Directory watch host lost the watch"), true);
      }
    }
  });
  const lost = () => {
    if (state.host === started) {
      state.host = undefined;
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
  if (state.remote) {
    return state.remote(directoryPath, listener, recursive);
  }
  const id = state.nextId++;
  const watch = Object.assign(new EventEmitter(), { path: directoryPath, recursive });
  watch.on("change", listener);
  try {
    register((state.host ??= startHost()), id, watch);
  } catch (error) {
    const host = state.host;
    host?.watches.delete(id);
    queueMicrotask(() => reportWatchError(host, watch, error, false));
  }
  return Object.assign(watch, {
    close() {
      watch.removeAllListeners("change");
      // Live watches always sit in the current helper; a lost one is in none.
      const current = state.host;
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
      state.host = undefined;
      if (current.watches.size) {
        // Each moved watch invalidates once when live again, covering the handoff.
        const next = (state.host = startHost());
        for (const [movedId, moved] of current.watches) {
          register(next, movedId, moved);
        }
        current.watches.clear();
      }
      current.child.stdin.end();
    },
  });
}

/** Give an owned worker access to this isolate's host without starting a helper. */
export function createDirectoryWatchChannel(): { port: MessagePort; close(): void } {
  const { port1, port2 } = new MessageChannel();
  const watches = new Map<number, DirectoryWatch>();
  const pending: WatchReply[] = [];
  const flush = () => {
    port1.postMessage(pending);
    pending.length = 0;
  };
  const post = (reply: WatchReply) => {
    // A stdout chunk delivers many events synchronously; preserve them in one worker message.
    if (!pending.length) {
      queueMicrotask(flush);
    }
    pending.push(reply);
  };
  const close = () => {
    for (const watch of watches.values()) {
      watch.close();
    }
    watches.clear();
    port1.close();
  };
  port1.on("close", close);
  port1.on("message", (request: WatchRequest) => {
    const { id } = request;
    if (!("path" in request)) {
      watches.get(id)?.close();
      watches.delete(id);
      return;
    }
    const watch = watchDirectory(
      request.path,
      (event, filename) => post({ id, event, filename }),
      request.recursive,
    );
    watches.set(id, watch);
    watch.on("error", (error, pathUnavailable) => {
      watches.delete(id);
      post({ id, error, pathUnavailable });
    });
  });
  port1.unref();
  return { port: port2, close };
}

/** Bind before the worker admits work. The port owns all subscriptions until the worker exits. */
export function installDirectoryWatchPort(port: MessagePort): void {
  const watches = new Map<number, EventEmitter>();
  let closed = false;
  const disconnected = () => new Error("Directory watch owner disconnected");
  port.on("message", (replies: WatchReply[]) => {
    for (const reply of replies) {
      const watch = watches.get(reply.id);
      if ("event" in reply) {
        watch?.emit("change", reply.event, reply.filename);
      } else {
        watches.delete(reply.id);
        watch?.emit("error", reply.error, reply.pathUnavailable);
      }
    }
  });
  port.on("close", () => {
    closed = true;
    const pending = [...watches.values()];
    watches.clear();
    for (const watch of pending) {
      watch.emit("error", disconnected(), false);
    }
  });
  port.unref();
  state.remote = (path, listener, recursive) => {
    const id = state.nextId++;
    const watch = new EventEmitter().on("change", listener);
    if (closed) {
      queueMicrotask(() => watch.emit("error", disconnected(), false));
    } else {
      watches.set(id, watch);
      port.postMessage({ id, path, recursive } satisfies WatchRequest);
    }
    return Object.assign(watch, {
      close() {
        if (watches.delete(id)) {
          port.postMessage({ id } satisfies WatchRequest);
        }
      },
    });
  };
}
