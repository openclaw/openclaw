import { once } from "node:events";
import type { Options } from "execa";
import {
  restoreExecaResult,
  type BrokerExecaOptions,
  type BrokerOutputOption,
} from "./execa-protocol.js";
import type { CommandSpawnOptions } from "./execa-types.js";
import type { SpawnBrokerHost } from "./host.js";

function isOutputOption(value: unknown): value is BrokerOutputOption | undefined {
  return (
    value === undefined ||
    value === "pipe" ||
    value === "ignore" ||
    value === "inherit" ||
    (typeof value === "object" &&
      value !== null &&
      "file" in value &&
      typeof value.file === "string" &&
      Object.keys(value).length === 1)
  );
}

/** Unsupported native descriptors and independent-lifetime commands remain explicit local paths. */
export function brokerExecaOptions(options: CommandSpawnOptions): BrokerExecaOptions | undefined {
  if (options.ipc || options.cleanup === false || typeof options.stdin === "number") {
    return undefined;
  }
  if (
    options.stdout === "inherit" ||
    options.stderr === "inherit" ||
    options.stdio === "inherit" ||
    typeof options.stdout === "number" ||
    typeof options.stderr === "number"
  ) {
    return undefined;
  }
  if (
    options.stdio &&
    typeof options.stdio !== "string" &&
    options.stdio.some((entry, fd) => typeof entry === "number" || (fd > 0 && entry === "inherit"))
  ) {
    return undefined;
  }
  if (
    (options.cwd !== undefined && typeof options.cwd !== "string") ||
    (options.input !== undefined &&
      typeof options.input !== "string" &&
      !(options.input instanceof Uint8Array)) ||
    (options.stdin !== undefined &&
      options.stdin !== "pipe" &&
      options.stdin !== "ignore" &&
      options.stdin !== "inherit") ||
    !isOutputOption(options.stdout) ||
    !isOutputOption(options.stderr) ||
    (options.shell !== undefined && options.shell !== false)
  ) {
    throw new TypeError("Unsupported spawn broker execa stream or invocation options");
  }
  if (
    Array.isArray(options.stdio) &&
    (options.stdio.length !== 3 ||
      !["pipe", "ignore", "inherit"].includes(String(options.stdio[0])) ||
      !isOutputOption(options.stdio[1]) ||
      !isOutputOption(options.stdio[2]))
  ) {
    throw new TypeError("Unsupported spawn broker execa stdio");
  }
  const { cancelSignal: _cancelSignal, ...serializable } = options;
  // SAFETY: The allowed options were checked above, excluding streams, URLs, IPC and native descriptors.
  return serializable as BrokerExecaOptions;
}

export function spawnBrokerCommand(
  host: SpawnBrokerHost,
  argv: string[],
  options: Options,
  prepared: BrokerExecaOptions,
) {
  const remote = host.spawnExeca(argv, prepared);
  const child = remote.child;
  const closed = child.waitForClose();
  const onAbort = () => {
    child.killed = true;
    remote.cancel();
  };
  options.cancelSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.cancelSignal?.aborted) {
    onAbort();
  }
  const promise = remote.result
    .then(async (result) => {
      if (result.timedOut) {
        child.killed = true;
      }
      // Result IPC can overtake the last bytes on separately transferred sockets.
      await closed;
      const restored = restoreExecaResult(result);
      // Broker admission refusals remain exceptions even for reject:false.
      if (
        restored instanceof Error &&
        (options.reject !== false || restored.code === "ERR_SPAWN_BROKER_UNAVAILABLE")
      ) {
        throw restored;
      }
      return restored;
    })
    .finally(() => options.cancelSignal?.removeEventListener("abort", onAbort));
  void promise.catch(() => {});
  void once(child, "spawn").then(
    () => {
      setImmediate(() => {
        for (const stream of [child.stdout, child.stderr]) {
          if (stream?.readableFlowing === null) {
            stream.resume();
          }
        }
      });
    },
    () => {},
  );
  const properties = {
    nodeChildProcess: child,
    get pid() {
      return child.pid;
    },
    get stdin() {
      return child.stdin;
    },
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    kill: (signal?: NodeJS.Signals | number) => child.kill(signal ?? options.killSignal),
  };
  const command = Object.assign(promise, properties);
  // Restore the accessors: child handles arrive after the promise is constructed.
  return Object.defineProperties(command, Object.getOwnPropertyDescriptors(properties));
}
