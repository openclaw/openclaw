// Owns one foreground Tailscale route claim and releases it when Gateway IPC closes.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { signalProcessTree } from "../process/kill-tree.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  TAILSCALE_ROUTE_OWNER_ARG,
  type TailscaleRouteOwnerMessage,
} from "./tailscale-route-owner-protocol.js";

// Tailscale prints this only after SetServeConfig succeeds and its foreground
// WatchIPNBus session owns the route. Treat earlier process startup as unclaimed.
const READY_MARKER = "Press Ctrl+C to exit.";
const OUTPUT_LIMIT = 200_000;
const STOP_GRACE_MS = 2_000;
const execFileAsync = promisify(execFile);

type RouteOwnerStart = { argv: string[] };

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function parseStart(raw: string | undefined): RouteOwnerStart {
  const parsed: unknown = JSON.parse(raw ?? "null");
  const argv = isRecord(parsed) ? parsed.argv : undefined;
  if (
    !Array.isArray(argv) ||
    !argv.every((entry) => typeof entry === "string") ||
    argv.length === 0
  ) {
    throw new Error("invalid Tailscale route-owner start payload");
  }
  return { argv };
}

const pendingReports = new Set<Promise<void>>();

function send(message: TailscaleRouteOwnerMessage): void {
  const sendMessage = process.send?.bind(process);
  if (!process.connected || !sendMessage) {
    return;
  }
  const report = new Promise<void>((resolve) => {
    try {
      sendMessage(message, () => resolve());
    } catch {
      // The parent can disappear between the connected check and send.
      resolve();
    }
  });
  pendingReports.add(report);
  void report.then(() => pendingReports.delete(report));
}

export type TailscaleRouteOwnerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopping: boolean;
};

export type TailscaleRouteOwnerHandle = {
  exited: Promise<TailscaleRouteOwnerExit>;
  stop: () => void;
};

async function signalChild(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  privileged: boolean,
  onError: (message: string) => void,
): Promise<void> {
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return;
  }
  if (process.platform !== "win32") {
    if (privileged) {
      // The detached, non-TTY sudo claim owns this group. An unprivileged
      // kill cannot reach its root processes; serve off cannot release it.
      try {
        await execFileAsync(
          "sudo",
          ["-n", "/bin/kill", `-${signal.slice(3)}`, "--", `-${child.pid}`],
          { timeout: 5_000, maxBuffer: 16_384 },
        );
      } catch {
        onError(
          `Could not stop the owned Tailscale process group ${child.pid} through sudo. ` +
            `Run \`sudo /bin/kill -TERM -- -${child.pid}\` to stop it, then ` +
            "`sudo tailscale set --operator=$USER` to avoid privileged claims.",
        );
      }
      return;
    }
    signalProcessTree(child.pid, signal, { detached: true });
    return;
  }
  child.kill(signal === "SIGKILL" ? "SIGTERM" : signal);
}

export function runTailscaleRouteOwner(
  start: RouteOwnerStart,
  sendMessage: (message: TailscaleRouteOwnerMessage) => void = send,
): TailscaleRouteOwnerHandle {
  const command = start.argv[0];
  if (!command) {
    throw new Error("Tailscale route-owner command is empty");
  }
  const args = start.argv.slice(1);
  const output = { stdout: "", stderr: "" };
  let ready = false;
  let stopping = false;
  let closed = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const signalOperations: Promise<void>[] = [];
  const exit = createDeferredCore<TailscaleRouteOwnerExit>();
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stop = () => {
    if (stopping || closed) {
      return;
    }
    stopping = true;
    const signal = (value: "SIGTERM" | "SIGKILL") => {
      signalOperations.push(
        signalChild(child, value, command === "sudo" && args[0] === "-n", (message) => {
          if (!closed) {
            sendMessage({ type: "stop-failed", message });
          }
        }),
      );
    };
    signal("SIGTERM");
    forceTimer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
    forceTimer.unref?.();
  };
  child.once("spawn", () => {
    if (typeof child.pid === "number") {
      sendMessage({ type: "spawned", pid: child.pid });
    }
  });
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      output[stream] = appendBounded(output[stream], chunk);
      if (!ready && output[stream].includes(READY_MARKER)) {
        ready = true;
        sendMessage({ type: "ready" });
      }
    });
  }
  child.once("error", (error) => {
    output.stderr = appendBounded(
      output.stderr,
      error instanceof Error ? error.message : String(error),
    );
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
    void Promise.all(signalOperations).then(() => {
      if (!stopping || !ready) {
        sendMessage({ type: "failed", code, signal, ...output });
      }
      exit.resolve({ code, signal, stopping });
    });
  });
  return { exited: exit.promise, stop };
}

if (process.argv[2] === TAILSCALE_ROUTE_OWNER_ARG) {
  let finalExitCode = 0;
  try {
    const owner = runTailscaleRouteOwner(parseStart(process.argv[3]));
    // The owner survives a Gateway process-group kill. IPC closure releases the
    // detached claim even when the Gateway cannot run its shutdown hooks.
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const onMessage = (message: unknown) => {
      if (isRecord(message) && message.type === "stop") {
        owner.stop();
      }
    };
    for (const signal of signals) {
      process.on(signal, owner.stop);
    }
    process.once("disconnect", owner.stop);
    process.once("message", onMessage);
    try {
      if (!process.connected) {
        owner.stop();
      }
      const exit = await owner.exited;
      finalExitCode = exit.stopping ? 0 : 1;
    } finally {
      // Retirement must not signal the departed claim again on our own disconnect.
      for (const signal of signals) {
        process.off(signal, owner.stop);
      }
      process.off("disconnect", owner.stop);
      process.off("message", onMessage);
    }
  } catch (error) {
    send({
      type: "failed",
      code: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    });
    finalExitCode = 1;
  } finally {
    // The foreground claim and its pipes have closed. Join its final failure
    // report before releasing the parent-owned IPC channel.
    await Promise.all(pendingReports);
    if (process.connected) {
      process.disconnect?.();
    }
    process.exitCode = finalExitCode;
  }
}
