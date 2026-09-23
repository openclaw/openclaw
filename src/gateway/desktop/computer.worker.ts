import { createInterface } from "node:readline";
import {
  requestExitAfterOneShotOutput,
  runCliWithExitFinalization,
} from "../../cli/one-shot-exit.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  ensureNodeHostPluginRegistry,
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "../../node-host/plugin-node-host.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  parseComputerHostInput,
  type ComputerHostExecutionClose,
  type ComputerHostOutput,
} from "./computer-protocol.js";

/** Private desktop process; shares node provider commands without a node connection. */
async function runComputerHost(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = new Map<string, AbortController>();
  const operations = new Set<Promise<void>>();
  const completion = createDeferredCore();
  const write = (message: ComputerHostOutput) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const log = (message: string) => process.stderr.write(`${message}\n`);
  let startup: Promise<void> | undefined;
  let stopWatching: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;

  const stop = (execution?: ComputerHostExecutionClose) => {
    if (stopping) {
      return stopping;
    }
    stopped = true;
    if (!execution) {
      for (const request of requests.values()) {
        request.abort(new Error("Computer host is stopping"));
      }
    }
    stopping = (async () => {
      await startup?.catch(() => {});
      await Promise.allSettled(operations);
      try {
        if (execution) {
          await invokeRegisteredNodeHostCommand(
            "computer.act",
            JSON.stringify({ action: "__close_execution", ...execution }),
          );
        }
        await notifyRegisteredNodeHostCommandDisconnect();
      } finally {
        stopWatching?.();
        input.close();
        requestExitAfterOneShotOutput();
      }
    })();
    void stopping.then(completion.resolve, completion.reject);
    return stopping;
  };
  const stopAfterError = (error: unknown) => {
    write({ type: "error", message: error instanceof Error ? error.message : String(error) });
    void stop();
  };

  input.on("line", (line) => {
    if (stopped) {
      return;
    }
    let message;
    try {
      message = parseComputerHostInput(JSON.parse(line));
    } catch {
      stopAfterError(new Error("Invalid computer host request"));
      return;
    }
    if (message.type === "stop") {
      void stop(message.execution);
      return;
    }
    if (message.type === "cancel") {
      requests.get(message.id)?.abort(new Error("Computer invocation cancelled"));
      return;
    }
    if (message.type === "start") {
      if (startup) {
        stopAfterError(new Error("Computer host was already started"));
        return;
      }
      const pluginIds = message.pluginIds;
      startup = (async () => {
        const config = getRuntimeConfig();
        const context = { config, env: process.env };
        await ensureNodeHostPluginRegistry({
          ...context,
          onlyPluginIds: pluginIds,
          commandAllowlist: new Set(["screen.snapshot", "computer.act"]),
          logger: { info: log, warn: log, error: log, debug: log },
        });
        if (stopped) {
          return;
        }
        const declaration = listRegisteredNodeHostCapsAndCommands(context);
        if (!declaration.computerUse || !declaration.commands.includes("screen.snapshot")) {
          throw new Error(
            "COMPUTER_DRIVER_UNAVAILABLE: the Gateway desktop provider is unavailable",
          );
        }
        stopWatching = watchRegisteredNodeHostCommandAvailability(context, () => {
          const next = listRegisteredNodeHostCapsAndCommands(context);
          if (!next.computerUse || !next.commands.includes("screen.snapshot")) {
            stopAfterError(new Error("COMPUTER_DRIVER_UNAVAILABLE: the desktop provider closed"));
          }
        });
        write({ type: "ready", computerUse: declaration.computerUse });
      })();
      void startup.catch(stopAfterError);
      return;
    }
    const request = message;
    if (!startup || requests.has(request.id)) {
      stopAfterError(new Error("Computer host request is not admitted"));
      return;
    }
    const controller = new AbortController();
    requests.set(request.id, controller);
    const operation = (async () => {
      try {
        await startup;
        controller.signal.throwIfAborted();
        if (stopped) {
          throw new Error("Computer host is stopping");
        }
        const payload = await invokeRegisteredNodeHostCommand(
          request.command,
          request.paramsJSON,
          undefined,
          {
            signal: controller.signal,
            sessionKey: request.sessionKey,
            sendNodeEvent: async () => {
              throw new Error("Computer host does not publish node events");
            },
          },
        );
        if (payload === null) {
          throw new Error("COMPUTER_DRIVER_UNAVAILABLE: computer command is unavailable");
        }
        write({ type: "result", id: request.id, payload });
      } catch (error) {
        write({
          type: "error",
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        requests.delete(request.id);
      }
    })();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  input.on("close", () => void stop());
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await completion.promise;
}

void runCliWithExitFinalization({
  run: runComputerHost,
  onError: (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
});
