import { randomUUID } from "node:crypto";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../../plugins/computer-use-contract.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { ManagedRun, ProcessSupervisor, RunExit } from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createPendingRequestRegistry } from "../../shared/pending-request-registry.js";
import {
  ComputerHostFinalizationError,
  parseComputerHostOutput,
  type ComputerHostCommand,
  type ComputerHostExecutionClose,
  type ComputerHostInput,
} from "./computer-protocol.js";

const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARS = 32 * 1024 * 1024;

export type ComputerHostProcess = {
  ready: Promise<ComputerUseCapabilityDescriptor>;
  isCurrent(): boolean;
  invoke(params: {
    command: ComputerHostCommand;
    params: Record<string, unknown>;
    signal?: AbortSignal;
    assertCurrent(): void;
    timeoutMs?: number;
    sessionKey?: string;
  }): Promise<unknown>;
  close(execution?: ComputerHostExecutionClose): Promise<void>;
};

/** The native driver inherits one desktop environment for its entire process lifetime. */
export function startComputerHostProcess(params: {
  env: NodeJS.ProcessEnv;
  pluginIds: string[];
  assertCurrent(): void;
  supervisor?: ProcessSupervisor;
}): ComputerHostProcess {
  const supervisor = params.supervisor ?? getProcessSupervisor();
  const scopeKey = `gateway-computer:${randomUUID()}`;
  const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "owned-only" });
  const ready = createDeferredCore<ComputerUseCapabilityDescriptor>();
  const pending = createPendingRequestRegistry<string, unknown, undefined>();
  let run: ManagedRun | undefined;
  let closing: Promise<void> | undefined;
  let active = true;
  let buffer = "";
  let failure: Error | undefined;
  const assertActive = () => {
    params.assertCurrent();
    if (!active) {
      throw failure ?? new Error("Gateway computer process is closed");
    }
  };

  const send = (message: ComputerHostInput) => {
    if (!run?.stdin || run.stdin.destroyed || run.stdin.writableEnded) {
      throw new Error("Gateway computer process input is closed");
    }
    run.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        fail(error);
      }
    });
  };
  const close = (execution?: ComputerHostExecutionClose) => {
    if (closing) {
      return closing;
    }
    if (active && run?.activity.resultSettled) {
      failure ??= new Error("Gateway computer process exited");
    }
    active = false;
    const closedError = failure ?? new Error("Gateway computer process is closed");
    ready.reject(closedError);
    pending.rejectAll(closedError);
    closing = (async () => {
      // Launch publishes native custody; readiness can fail while custody still needs cleanup.
      await launch;
      let exit: RunExit | undefined;
      let waitFailure: Error | undefined;
      if (run) {
        if (!run.activity.resultSettled) {
          try {
            send({ type: "stop", ...(execution ? { execution } : {}) });
          } catch {
            run.cancel("manual-cancel");
          }
        }
        const timer = setTimeout(() => run?.cancel("manual-cancel"), SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
        try {
          exit = await run.wait();
        } catch (error) {
          waitFailure = error instanceof Error ? error : new Error(String(error));
        } finally {
          clearTimeout(timer);
        }
      }
      await cleanupScope();
      if (waitFailure) {
        throw waitFailure;
      }
      if (exit && (exit.exitCode !== 0 || exit.exitSignal !== null)) {
        failure ??= new Error(
          `Gateway computer helper shutdown failed (${exit.exitSignal ?? `exit ${exit.exitCode}`})`,
        );
      }
      if (failure) {
        throw new ComputerHostFinalizationError(failure);
      }
    })();
    void closing.catch((error: unknown) => {
      if (!(error instanceof ComputerHostFinalizationError)) {
        closing = undefined;
      }
    });
    return closing;
  };
  const fail = (error: Error) => {
    failure ??= error;
    active = false;
    ready.reject(error);
    pending.rejectAll(error);
    void close().catch(() => {});
  };
  const receive = (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_MESSAGE_CHARS) {
      fail(new Error("Gateway computer response exceeds the transport limit"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = parseComputerHostOutput(JSON.parse(line));
        if (message.type === "ready") {
          ready.resolve(parseComputerUseCapabilityDescriptor(message.computerUse));
        } else if (message.type === "result") {
          const payload: unknown = JSON.parse(message.payload);
          pending.take(message.id)?.resolve(payload);
        } else if (message.id) {
          pending.take(message.id)?.reject(new Error(message.message));
        } else {
          fail(new Error(message.message));
        }
      } catch {
        fail(new Error("Invalid Gateway computer response"));
      }
    }
  };

  const startupTimer = setTimeout(
    () => fail(new Error("Gateway computer provider startup timed out")),
    STARTUP_TIMEOUT_MS,
  );
  startupTimer.unref?.();
  void ready.promise.then(
    () => clearTimeout(startupTimer),
    () => clearTimeout(startupTimer),
  );
  // Return cleanup custody before deferred admission can acquire a native process.
  const launch = Promise.resolve().then(async () => {
    if (!active) {
      return;
    }
    try {
      const node = resolveExecutablePath("node", { env: params.env });
      if (!node) {
        throw new Error("Gateway computer control requires Node.js in PATH");
      }
      const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.computerHost);
      assertActive();
      run = await supervisor.spawn({
        scopeKey,
        mode: "child",
        argv: [node, ...resolveRuntimeWorkerArgv(worker, node)],
        env: params.env,
        exactEnv: true,
        stdinMode: "pipe-open",
        captureOutput: false,
        onStdout: receive,
        assertCurrent: assertActive,
      });
      void run.wait().then(
        () => {
          if (!closing) {
            fail(new Error("Gateway computer process exited"));
          }
        },
        (error: unknown) => {
          if (!closing) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      assertActive();
      send({ type: "start", pluginIds: params.pluginIds });
    } catch (error) {
      if (!closing) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  return {
    ready: ready.promise,
    isCurrent: () => active,
    async invoke(request) {
      await ready.promise;
      assertActive();
      request.assertCurrent();
      request.signal?.throwIfAborted();
      const id = randomUUID();
      let timedOut = false;
      const cancel = () => {
        try {
          send({ type: "cancel", id });
        } catch {}
      };
      const abort = () => {
        cancel();
        pending
          .take(id)
          ?.reject(request.signal?.reason ?? new Error("Computer invocation cancelled"));
      };
      const entry = pending.add(id, {
        value: undefined,
        timeoutMs: request.timeoutMs ?? 60_000,
        timeoutError: () => new Error("Gateway computer invocation timed out"),
        onTimeout: () => {
          timedOut = true;
          cancel();
        },
        dispose: () => request.signal?.removeEventListener("abort", abort),
      });
      if (!entry) {
        throw new Error("Gateway computer request already exists");
      }
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        assertActive();
        request.assertCurrent();
        request.signal?.throwIfAborted();
        send({
          type: "invoke",
          id,
          command: request.command,
          paramsJSON: JSON.stringify(request.params),
          ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        });
      } catch (error) {
        pending.take(id)?.reject(error);
      }
      try {
        return await entry.promise;
      } catch (error) {
        if (request.signal?.aborted || timedOut || !active) {
          await close();
        }
        throw error;
      }
    },
    close,
  };
}
