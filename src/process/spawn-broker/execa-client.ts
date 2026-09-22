import { once } from "node:events";
import type { Options } from "execa";
import {
  restoreExecaResult,
  type BrokerExecaOptions,
  type BrokerOutputOption,
} from "./execa-protocol.js";
import type { SpawnBrokerHost } from "./host.js";

export type { CommandSubprocess } from "./execa-types.js";

const SERIALIZABLE_OPTIONS = new Set([
  "buffer",
  "cancelSignal",
  "cwd",
  "detached",
  "encoding",
  "env",
  "extendEnv",
  "forceKillAfterDelay",
  "input",
  "killDescendants",
  "killSignal",
  "maxBuffer",
  "reject",
  "shell",
  "stderr",
  "stdin",
  "stdio",
  "stdout",
  "stripFinalNewline",
  "timeout",
  "windowsHide",
  "windowsVerbatimArguments",
]);

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
export function brokerExecaOptions(options: Options): BrokerExecaOptions | undefined {
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
  for (const key of Object.keys(options)) {
    if (!SERIALIZABLE_OPTIONS.has(key)) {
      throw new TypeError(`Unsupported spawn broker execa option: ${key}`);
    }
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
    options.stdio !== undefined &&
    typeof options.stdio === "string" &&
    options.stdio !== "pipe" &&
    options.stdio !== "ignore"
  ) {
    throw new TypeError("Unsupported spawn broker execa stdio");
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
      // Result IPC can overtake the last bytes on separately transferred sockets.
      await closed;
      const restored = restoreExecaResult(result);
      if (restored instanceof Error && options.reject !== false) {
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
