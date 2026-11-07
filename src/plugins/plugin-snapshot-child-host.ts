import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as workerThreads from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeArgs,
  runtimeNeedsTypeScriptLoader,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import {
  PLUGIN_SNAPSHOT_CHILD_ARG,
  type PluginSnapshotChildEnvelope,
  type PluginSnapshotChildWorkerData,
  type PluginSnapshotChildControl,
  type PluginSnapshotChildFailure,
} from "./plugin-snapshot-child-transport.js";
import type { AcquiredPluginSharedSourceSnapshot } from "./plugin-source-snapshot-shared.js";

type Child = workerThreads.Worker | childProcess.ChildProcess;
const require = createRequire(import.meta.url);

/** Builtin facades are scoped to one snapshot instance, including its descendant lifetime. */
export function createPluginSnapshotChildHost(params: {
  snapshot: AcquiredPluginSharedSourceSnapshot;
  workerData?: unknown;
  onInvalidSnapshot?: (failure: PluginSnapshotChildFailure) => void | Promise<void>;
}) {
  const bootstrap = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginSnapshotChild);
  const preload = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginSnapshotChildPreload);
  const children = new Map<Child, Promise<void>>();
  let disposed = false;
  const envelope = (
    entry: PluginSnapshotChildEnvelope["entry"],
    execArgv: string[],
    argv: string[],
    nodeOptions = process.env.NODE_OPTIONS,
  ): PluginSnapshotChildEnvelope => ({
    version: 1,
    id: randomUUID(),
    stateDir: params.snapshot.stateDir,
    descriptor: params.snapshot.descriptor,
    entry,
    execArgv,
    argv,
    nodeOptions: nodeOptions ?? null,
  });
  const preloads = (execPath = process.execPath) => {
    const filename = fileURLToPath(preload);
    const bun = resolveRuntimeArgs(execPath).length > 0;
    return bun
      ? ["--preload", filename]
      : [
          ...(runtimeNeedsTypeScriptLoader(filename, execPath)
            ? ["--require", require.resolve("tsx/cjs")]
            : []),
          "--require",
          filename,
        ];
  };
  const environment = (env: NodeJS.ProcessEnv, execPath = process.execPath) =>
    resolveRuntimeArgs(execPath).length > 0
      ? { ...env }
      : {
          ...env,
          NODE_OPTIONS: [
            ...preloads(execPath).map((value) => JSON.stringify(value)),
            env.NODE_OPTIONS ?? "",
          ].join(" "),
        };
  const retain = () => {
    if (disposed) {
      throw new Error("Plugin snapshot child owner has been disposed");
    }
    params.snapshot.assertCurrent();
    return params.snapshot.retain();
  };
  const track = (child: Child, lease: AcquiredPluginSharedSourceSnapshot) => {
    const settled = new Promise<void>((resolve) => {
      child.once(child instanceof workerThreads.Worker ? "exit" : "close", () => {
        children.delete(child);
        lease.release();
        resolve();
      });
    });
    children.set(child, settled);
    return child;
  };
  const report = (child: Child, launch: PluginSnapshotChildEnvelope, value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("snapshotChild" in value) ||
      value.snapshotChild !== launch.id
    ) {
      return false;
    }
    const message = value as PluginSnapshotChildControl;
    if (
      message.failure?.artifactPath !== params.snapshot.descriptor.artifact.path ||
      typeof message.failure.message !== "string"
    ) {
      return false;
    }
    void Promise.resolve(params.onInvalidSnapshot?.(message.failure)).catch((error: unknown) =>
      child.emit("error", error),
    );
    return true;
  };
  const workerEntry = (filename: string | URL, options: workerThreads.WorkerOptions) => {
    if (options.eval) {
      if (typeof filename !== "string") {
        throw new TypeError("Worker eval requires a string");
      }
      return {
        kind: "source" as const,
        filename: path.join(process.cwd(), "[worker eval]"),
        source: filename,
        format:
          process.versions.bun && Reflect.get(options, "type") === "module"
            ? ("module" as const)
            : ("commonjs" as const),
      };
    }
    if (filename instanceof URL && filename.protocol === "data:") {
      const comma = filename.href.indexOf(",");
      const header = filename.href.slice(0, comma);
      return {
        kind: "source" as const,
        filename: path.join(process.cwd(), "[worker data]"),
        source: /;base64$/iu.test(header)
          ? Buffer.from(filename.href.slice(comma + 1), "base64").toString("utf8")
          : decodeURIComponent(filename.href.slice(comma + 1)),
        format: "module" as const,
      };
    }
    const target = filename instanceof URL ? fileURLToPath(filename) : path.resolve(filename);
    params.snapshot.assertMemberPath(target);
    return { kind: "file" as const, filename: target };
  };
  const Worker = new Proxy(workerThreads.Worker, {
    construct(target, args: [string | URL, workerThreads.WorkerOptions?], newTarget) {
      const [filename, options = {}] = args;
      const lease = retain();
      const { port1, port2 } = new workerThreads.MessageChannel();
      try {
        const originalEnv =
          options.env === workerThreads.SHARE_ENV ? process.env : (options.env ?? process.env);
        const launch = envelope(
          workerEntry(filename, options),
          options.execArgv ?? process.execArgv,
          options.argv?.map(String) ?? [],
          originalEnv.NODE_OPTIONS,
        );
        const workerData: PluginSnapshotChildWorkerData = {
          envelope: launch,
          value: options.workerData,
          control: port2,
        };
        const child = Reflect.construct(
          target,
          [
            bootstrap,
            {
              ...options,
              eval: false,
              argv: launch.argv,
              env: options.env === workerThreads.SHARE_ENV ? options.env : environment(originalEnv),
              execArgv: [...preloads(), ...launch.execArgv],
              workerData,
              transferList: [...(options.transferList ?? []), port2],
            },
          ],
          newTarget,
        );
        port1.on("message", (message: unknown) => report(child, launch, message));
        port1.unref();
        child.once("exit", () => port1.close());
        return track(child, lease);
      } catch (error) {
        port1.close();
        port2.close();
        lease.release();
        throw error;
      }
    },
  });
  const isArguments = (
    value: readonly string[] | childProcess.ForkOptions | undefined,
  ): value is readonly string[] => Array.isArray(value);
  const fork: typeof childProcess.fork = (
    modulePath: string | URL,
    argsOrOptions?: readonly string[] | childProcess.ForkOptions,
    suppliedOptions?: childProcess.ForkOptions,
  ) => {
    const args = isArguments(argsOrOptions) ? [...argsOrOptions] : [];
    const options = (isArguments(argsOrOptions) ? suppliedOptions : argsOrOptions) ?? {};
    const lease = retain();
    try {
      const filename =
        modulePath instanceof URL ? fileURLToPath(modulePath) : path.resolve(modulePath);
      params.snapshot.assertMemberPath(filename);
      const launch = envelope(
        { kind: "file", filename },
        options.execArgv ?? process.execArgv,
        args,
        (options.env ?? process.env).NODE_OPTIONS,
      );
      const child = childProcess.fork(
        fileURLToPath(bootstrap),
        [
          PLUGIN_SNAPSHOT_CHILD_ARG,
          Buffer.from(JSON.stringify(launch)).toString("base64url"),
          ...args,
        ],
        {
          ...options,
          env: environment(options.env ?? process.env, options.execPath),
          execArgv: [...preloads(options.execPath), ...launch.execArgv],
        },
      );
      const emit = child.emit.bind(child);
      child.emit = function (event: string | symbol, ...values: unknown[]) {
        if (event === "message" && report(child, launch, values[0])) {
          return true;
        }
        return emit(event, ...values);
      };
      return track(child, lease) as childProcess.ChildProcess;
    } catch (error) {
      lease.release();
      throw error;
    }
  };
  const workers = {
    ...workerThreads,
    Worker,
    workerData: Object.hasOwn(params, "workerData") ? params.workerData : workerThreads.workerData,
  };
  const processes = { ...childProcess, fork };
  return {
    loadBuiltin(specifier: string): unknown {
      if (specifier === "node:worker_threads" || specifier === "worker_threads") {
        return workers;
      }
      if (specifier === "node:child_process" || specifier === "child_process") {
        return processes;
      }
      return undefined;
    },
    async disposeAsync() {
      disposed = true;
      const pending = [...children];
      for (const [child] of pending) {
        if (child instanceof workerThreads.Worker) {
          void child.terminate();
        } else {
          child.kill("SIGKILL");
        }
      }
      await Promise.all(pending.map(([, settled]) => settled));
    },
  };
}
