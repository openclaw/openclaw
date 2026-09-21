import { spawn, type ChildProcess, type SendHandle } from "node:child_process";
import { Socket } from "node:net";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { killProcessTree } from "../kill-tree.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { hasLiveOwnedProcessGroupMembers } from "../supervisor/service-child-group-ownership.js";
import { serializeExecaError } from "./execa-protocol.js";
import { startBrokerExeca } from "./execa-worker.js";
import { createBrokerReceiver } from "./ipc.js";
import { holdPipeForTransfer, takePipePrefix } from "./pipe.js";
import {
  serializeBrokerError,
  SpawnBrokerError,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";
import { createWorkerSender } from "./worker-sender.js";

type ExecaRun = Awaited<ReturnType<typeof startBrokerExeca>>;
type Owned = {
  child: ChildProcess;
  detached: boolean;
  execa?: ExecaRun;
  announced: boolean;
  events: BrokerResponse[];
  exited: boolean;
  resultSettled: boolean;
  openPipes: Set<number>;
};
type Admission = { type: "started"; entry: Owned } | { type: "failed"; execa: ExecaRun };
const owned = new Map<number, Owned>();
const receiver = createBrokerReceiver();
let stopping = false;
const starting = new Map<number, { canceled?: boolean; signal?: NodeJS.Signals | number }>();

const sender = createWorkerSender((message, handle, callback) => {
  if (!process.send || !process.connected) {
    callback(new Error("Spawn broker parent disconnected"));
    return;
  }
  process.send(message, handle, { keepOpen: false }, callback);
});

function report(message: BrokerResponse, handle?: SendHandle): Promise<void> {
  return sender.send(message, handle).catch((error: unknown) => {
    shutdown();
    throw error;
  });
}

function forget(id: number, entry: Owned): void {
  if (entry.announced && entry.exited && entry.resultSettled && entry.openPipes.size === 0) {
    owned.delete(id);
  }
}

function shutdown(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  sender.close(new Error("Spawn broker parent disconnected"));
  receiver.clear();
  const terminations: Array<ReturnType<typeof killProcessTree>> = [];
  for (const entry of owned.values()) {
    if (entry.child.connected) {
      entry.child.disconnect();
    }
    if (entry.child.pid) {
      terminations.push(
        killProcessTree(entry.child.pid, {
          detached: entry.detached,
          graceMs: GRACEFUL_CANCEL_TIMEOUT_MS,
        }),
      );
    }
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-process.pid, signal);
    } catch {
      /* An absent private group needs no signal. */
    }
  };
  const finish = () => {
    // Killing our own group must not cancel the timers for detached children.
    for (const termination of terminations) {
      termination?.force();
    }
    signalGroup("SIGKILL");
    process.exit(0);
  };
  signalGroup("SIGTERM");
  if (owned.size === 0 && starting.size === 0 && hasLiveOwnedProcessGroupMembers() === false) {
    finish();
    return;
  }
  setTimeout(finish, GRACEFUL_CANCEL_TIMEOUT_MS + 250);
}

function disposeFailedChild(child: ChildProcess | undefined): void {
  if (!child) {
    return;
  }
  // Setup can fail before Node emits its queued spawn error.
  child.once("error", () => {});
  if (child.pid) {
    child.kill("SIGKILL");
  }
  if (child.connected) {
    child.disconnect();
  }
  for (const stream of child.stdio ?? []) {
    stream?.destroy();
  }
}

async function launch(
  message: Extract<BrokerRequest, { type: "spawn" | "spawn-execa" }>,
): Promise<void> {
  if (stopping || owned.size + starting.size >= 256) {
    const error = new SpawnBrokerError("Spawn broker request capacity exceeded");
    // The ordered failed-admission result proves no native work was started.
    // No command metadata exists because this guard precedes spawn preparation.
    await report({
      type: "execa-result",
      id: message.id,
      result: {
        failed: true,
        code: error.code,
        timedOut: false,
        isCanceled: false,
        isGracefullyCanceled: false,
        isMaxBuffer: false,
        isTerminated: false,
        isForcefullyTerminated: false,
        command: "",
        escapedCommand: "",
        cwd: process.cwd(),
        durationMs: 0,
        error: serializeExecaError(error),
      },
    });
    await report({
      type: "error",
      id: message.id,
      error: serializeBrokerError(error),
      resultUnavailable: true,
    });
    return;
  }
  const pending: { canceled?: boolean; signal?: NodeJS.Signals | number } = {};
  starting.set(message.id, pending);
  let spawnedChild: ChildProcess | undefined;
  const assertActive = () => {
    if (stopping || !process.connected) {
      throw new Error("Spawn broker is stopping");
    }
  };
  try {
    // Reserve the outbound channel before forking: ownership cannot wait behind
    // another descriptor acknowledgement or a large buffered command result.
    const admission = await sender.reserve<Admission>(async (publish) => {
      assertActive();
      const execa =
        message.type === "spawn-execa"
          ? await startBrokerExeca(message.argv, message.options, assertActive)
          : undefined;
      const child =
        execa?.child ??
        (message.type === "spawn"
          ? spawn(message.argv[0]!, message.argv.slice(1), message.options)
          : undefined);
      spawnedChild = child;
      if (!child) {
        throw new Error("Spawn broker command did not start");
      }
      if (!execa) {
        // EMFILE/ENFILE can return before stdio exists; Node still owns error and close.
        if (child.stdio === undefined) {
          const closed = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
          });
          const error = await new Promise<Error>((resolve) => {
            child.once("error", resolve);
          });
          await closed;
          throw error;
        }
        for (const [fd, stream] of child.stdio.entries()) {
          if (fd > 0 && stream instanceof Socket) {
            holdPipeForTransfer(stream);
          }
        }
      }
      if (execa && !child.pid) {
        for (const [fd] of execa.stdio.entries()) {
          execa.outputDrained(fd);
        }
        disposeFailedChild(child);
        return { type: "failed", execa };
      }
      const current: Owned = {
        child,
        detached:
          message.options.detached === true ||
          (message.type === "spawn-execa" && message.options.killDescendants === true),
        execa,
        announced: false,
        events: [],
        exited: false,
        resultSettled: !execa,
        openPipes: new Set(
          (execa?.stdio ?? child.stdio).flatMap((stream, fd) =>
            stream instanceof Socket ? [fd] : [],
          ),
        ),
      };
      owned.set(message.id, current);
      if (pending.canceled) {
        execa?.cancel();
      }
      if (pending.signal !== undefined) {
        (execa?.kill ?? child.kill.bind(child))(pending.signal);
      }
      const event = (value: BrokerResponse) => {
        if (current.announced) {
          void report(value).catch(() => {});
        } else if (current.events.length < 32) {
          current.events.push(value);
        } else {
          child.kill("SIGKILL");
          shutdown();
        }
      };
      child.on("error", (error) =>
        event({ type: "error", id: message.id, error: serializeBrokerError(error) }),
      );
      child.on("message", (payload: object) =>
        event({ type: "ipc", id: message.id, message: payload }),
      );
      child.once("disconnect", () => event({ type: "disconnect", id: message.id }));
      child.once("exit", (code, signal) => event({ type: "exit", id: message.id, code, signal }));
      child.once("close", () => {
        event({ type: "closed", id: message.id });
        current.exited = true;
        forget(message.id, current);
      });
      if (execa) {
        void execa.result
          .then(async (result) => {
            event({ type: "execa-result", id: message.id, result });
            current.resultSettled = true;
            forget(message.id, current);
          })
          .catch((error: unknown) => {
            event({
              type: "error",
              id: message.id,
              error: serializeBrokerError(toErrorObject(error, "Spawn broker execa result failed")),
              resultUnavailable: true,
            });
            current.resultSettled = true;
            forget(message.id, current);
          });
      }
      if (!execa) {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      }
      if (!child.pid) {
        throw new Error("Spawn broker command has no process identifier");
      }
      await publish({ type: "owned", id: message.id, pid: child.pid });
      return { type: "started", entry: current };
    });
    if (admission.type === "failed") {
      const result = await admission.execa.result;
      await report({ type: "execa-result", id: message.id, result });
      await report({
        type: "error",
        id: message.id,
        error: {
          message: result.error?.message ?? result.shortMessage ?? "Command could not be spawned",
          code: result.code,
        },
      });
      return;
    }
    const current = admission.entry;
    const { child, execa } = current;
    if (stopping) {
      if (child.connected) {
        child.disconnect();
      }
      if (child.pid) {
        killProcessTree(child.pid, {
          detached: current.detached,
          graceMs: GRACEFUL_CANCEL_TIMEOUT_MS,
        });
      }
      return;
    }
    const streams = execa?.stdio ?? child.stdio;
    for (const [fd, stream] of streams.entries()) {
      if (!(stream instanceof Socket)) {
        continue;
      }
      stream.pause();
      await report({ type: "pipe", id: message.id, fd }, stream);
      if (fd > 0) {
        await report({ type: "pipe-prefix", id: message.id, fd, bytes: takePipePrefix(stream) });
      }
      if (!execa) {
        stream.destroy();
      }
    }
    if (!child.pid) {
      throw new Error("Spawn broker command has no process identifier");
    }
    await report({
      type: "spawned",
      id: message.id,
      pid: child.pid,
      spawnfile: child.spawnfile,
      spawnargs: child.spawnargs,
      connected: child.connected,
      stdioLength: streams.length,
    });
    // Keep new arrivals behind earlier startup events while their IPC writes drain.
    for (;;) {
      const value = current.events.shift();
      if (value === undefined) {
        break;
      }
      await report(value);
    }
    current.announced = true;
    forget(message.id, current);
  } catch (error) {
    disposeFailedChild(spawnedChild);
    owned.delete(message.id);
    if (!stopping) {
      await report({
        type: "error",
        id: message.id,
        error: serializeBrokerError(error instanceof Error ? error : new Error(String(error))),
        resultUnavailable: true,
      });
    }
  } finally {
    starting.delete(message.id);
  }
}

process.once("disconnect", shutdown);
const onSupervisorSignal = () => {
  // A cgroup stop can reach the broker before the Gateway finishes child cleanup.
  // Keep its transport alive until the parent relinquishes ownership through IPC.
  if (!process.connected) {
    shutdown();
  }
};
process.on("SIGTERM", onSupervisorSignal);
process.on("SIGINT", onSupervisorSignal);
process.on("message", (raw: unknown, handle: SendHandle) => {
  // Only the version-matched parent can write this private IPC channel.
  let decoded: unknown;
  try {
    decoded = receiver.receive(raw);
  } catch {
    shutdown();
    return;
  }
  if (decoded === undefined) {
    return;
  }
  // SAFETY: The version-matched host is the sole sender on this private IPC channel.
  const message = decoded as BrokerRequest;
  if (message.type === "shutdown") {
    shutdown();
    return;
  }
  if (message.type === "pipe-received") {
    sender.acknowledge(message.id, message.fd);
    return;
  }
  if (message.type === "spawn" || message.type === "spawn-execa") {
    void launch(message).catch(shutdown);
    return;
  }
  const entry = owned.get(message.id);
  if (!entry) {
    const pending = starting.get(message.id);
    if (pending && message.type === "cancel") {
      pending.canceled = true;
    }
    if (pending && message.type === "kill") {
      pending.signal = message.signal;
    }
    if (message.type === "ipc") {
      void report({
        type: "ipc-sent",
        id: message.id,
        sequence: message.sequence,
        error: { message: "Child process IPC channel is closed" },
      }).catch(() => {});
    }
    return;
  }
  if (message.type === "kill") {
    (entry.execa?.kill ?? entry.child.kill.bind(entry.child))(message.signal);
  } else if (message.type === "cancel") {
    entry.execa?.cancel();
  } else if (message.type === "output-drained") {
    entry.execa?.outputDrained(
      message.fd,
      message.error ? Object.assign(new Error(message.error.message), message.error) : undefined,
    );
    entry.openPipes.delete(message.fd);
    forget(message.id, entry);
  } else if (message.type === "disconnect" && entry.child.connected) {
    entry.child.disconnect();
  } else if (message.type === "ipc") {
    const acknowledge = (error: Error | null) => {
      void report({
        type: "ipc-sent",
        id: message.id,
        sequence: message.sequence,
        ...(error ? { error: serializeBrokerError(error) } : {}),
      }).catch(() => {});
    };
    if (!entry.child.connected) {
      acknowledge(new Error("Child process IPC channel is closed"));
    } else {
      try {
        entry.child.send(message.message, handle, { keepOpen: true }, acknowledge);
      } catch (error) {
        acknowledge(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
});
void report({ type: "ready", pid: process.pid }).catch(shutdown);
