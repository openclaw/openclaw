import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { RunAgentAttemptParams } from "../command/attempt-execution.js";
import type {
  AgentRuntimeWorkerRunParams,
  AgentWorkerToParentMessage,
  RunAgentAttemptResult,
} from "./agent-runtime.types.js";
import { deserializeWorkerError } from "./errors.js";
import { buildAgentWorkerPermissionExecArgv } from "./permissions.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export class AgentWorkerUnsupportedParamsError extends Error {
  constructor(readonly keys: string[]) {
    super(`Agent runtime worker experiment does not support params: ${keys.join(", ")}`);
    this.name = "AgentWorkerUnsupportedParamsError";
  }
}

export type RunAgentAttemptInWorkerOptions = {
  /** Test seam; production uses the compiled agent-runtime.worker entry. */
  workerUrl?: URL;
  /** Test seam; production inherits the parent process execArgv. */
  execArgv?: string[];
  /** Test seam; production follows config/env permission settings. */
  usePermissions?: boolean;
};

type RuntimeIsolationDecisionParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function readBooleanOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

export function shouldRunAgentCommandAttemptInWorker(
  params: RuntimeIsolationDecisionParams = {},
): boolean {
  const env = params.env ?? process.env;
  const explicit =
    readBooleanOverride(env.OPENCLAW_AGENT_RUNTIME_WORKER) ??
    readBooleanOverride(env.OPENCLAW_AGENT_WORKER_EXPERIMENT);
  if (explicit !== undefined) {
    return explicit;
  }
  return params.config?.agents?.defaults?.experimental?.runtimeIsolation?.mode === "worker";
}

function shouldUseWorkerPermissions(
  config: OpenClawConfig | undefined,
  env = process.env,
): boolean {
  const explicit =
    readBooleanOverride(env.OPENCLAW_AGENT_RUNTIME_WORKER_PERMISSIONS) ??
    readBooleanOverride(env.OPENCLAW_AGENT_WORKER_PERMISSIONS);
  if (explicit !== undefined) {
    return explicit;
  }
  return config?.agents?.defaults?.experimental?.runtimeIsolation?.permissions === true;
}

function resolveWorkerUrl(): URL {
  const current = import.meta.url;
  return new URL(
    current.endsWith(".ts") ? "./agent-runtime.worker.ts" : "./agent-runtime.worker.js",
    current,
  );
}

function serializeAbortReason(reason: unknown): unknown {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return reason;
}

function serializeInitialAbort(signal: AbortSignal | undefined): { reason?: unknown } | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  return { reason: serializeAbortReason(signal.reason) };
}

type ParentVisibleAgentEvent = Parameters<typeof emitAgentEvent>[0];
type CallbackAgentEvent = Parameters<RunAgentAttemptParams["onAgentEvent"]>[0];

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toParentVisibleAgentEvent(
  params: RunAgentAttemptParams,
  event: AgentWorkerToParentMessage & { type: "agentEvent"; origin: "runtime" },
): ParentVisibleAgentEvent {
  const runId = readNonEmptyString(event.event.runId) ?? params.runId;
  const sessionKey =
    readNonEmptyString(event.event.sessionKey) ??
    (runId === params.runId ? params.sessionKey : undefined);
  return {
    runId,
    stream: event.event.stream,
    data: event.event.data,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function toCallbackAgentEvent(event: ParentVisibleAgentEvent): CallbackAgentEvent {
  return {
    stream: event.stream,
    data: event.data,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };
}

function isActiveAttemptEvent(
  params: RunAgentAttemptParams,
  event: ParentVisibleAgentEvent,
): boolean {
  return event.runId === params.runId;
}

function stripWorkerCallbacks(params: RunAgentAttemptParams): AgentRuntimeWorkerRunParams {
  const unsupported: string[] = [];
  if (params.opts.abortSignal && typeof params.opts.abortSignal !== "object") {
    unsupported.push("opts.abortSignal");
  }

  if (unsupported.length > 0) {
    throw new AgentWorkerUnsupportedParamsError(unsupported);
  }

  const {
    onAgentEvent: _onAgentEvent,
    onUserMessagePersisted: _onUserMessagePersisted,
    ...rest
  } = params;
  const { abortSignal: _abortSignal, ...opts } = params.opts;
  return { ...rest, opts };
}

function syncParentSessionStoreFromDisk(params: RunAgentAttemptParams): void {
  if (!params.sessionStore || !params.storePath || !fs.existsSync(params.storePath)) {
    return;
  }
  const latest = loadSessionStore(params.storePath, { skipCache: true, clone: false });
  const mutableStore = params.sessionStore as Record<string, SessionEntry>;
  for (const key of Object.keys(mutableStore)) {
    delete mutableStore[key];
  }
  Object.assign(mutableStore, latest);
}

export async function runAgentAttemptInWorker(
  params: RunAgentAttemptParams,
  options: RunAgentAttemptInWorkerOptions = {},
): Promise<RunAgentAttemptResult> {
  const workerParams = stripWorkerCallbacks(params);
  const worker = new Worker(options.workerUrl ?? resolveWorkerUrl(), {
    execArgv:
      (options.usePermissions ?? shouldUseWorkerPermissions(params.cfg))
        ? [
            ...(options.execArgv ?? process.execArgv),
            ...buildAgentWorkerPermissionExecArgv({
              workspaceDir: params.workspaceDir,
              agentDir: params.agentDir,
              sessionFile: params.sessionFile,
              storePath: params.storePath,
            }),
          ]
        : (options.execArgv ?? process.execArgv),
    name: `openclaw-agent-runtime:${params.sessionAgentId}:${params.sessionId}`,
  });

  let settled = false;
  const cleanup = () => {
    params.opts.abortSignal?.removeEventListener("abort", abort);
    if (!settled) {
      void worker.terminate();
    }
  };
  const abort = () => {
    // oxlint-disable unicorn/require-post-message-target-origin -- worker_threads Worker has no targetOrigin.
    worker.postMessage({
      type: "abort",
      reason: serializeAbortReason(params.opts.abortSignal?.reason),
    });
    // oxlint-enable unicorn/require-post-message-target-origin
  };

  return await new Promise<RunAgentAttemptResult>((resolve, reject) => {
    worker.once("error", (error) => {
      settled = true;
      cleanup();
      try {
        syncParentSessionStoreFromDisk(params);
        reject(error);
      } catch (syncError) {
        reject(syncError);
      }
    });
    worker.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        syncParentSessionStoreFromDisk(params);
        reject(new Error(`Agent runtime worker exited before completing run (code ${code})`));
      } catch (syncError) {
        reject(syncError);
      }
    });
    worker.on("message", (message: AgentWorkerToParentMessage) => {
      if (message.type === "agentEvent") {
        if (message.origin === "runtime") {
          const event = toParentVisibleAgentEvent(params, message);
          emitAgentEvent(event);
          if (isActiveAttemptEvent(params, event)) {
            params.onAgentEvent(toCallbackAgentEvent(event));
          }
        } else {
          params.onAgentEvent(message.event);
        }
        return;
      }
      if (message.type === "userMessagePersisted") {
        params.onUserMessagePersisted?.(message.message);
        return;
      }
      if (message.type === "result") {
        settled = true;
        cleanup();
        try {
          syncParentSessionStoreFromDisk(params);
          resolve(message.result);
        } catch (error) {
          reject(error);
        } finally {
          void worker.terminate();
        }
        return;
      }
      if (message.type === "error") {
        settled = true;
        cleanup();
        try {
          syncParentSessionStoreFromDisk(params);
          reject(deserializeWorkerError(message));
        } catch (error) {
          reject(error);
        } finally {
          void worker.terminate();
        }
      }
    });

    params.opts.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      // oxlint-disable unicorn/require-post-message-target-origin -- worker_threads Worker has no targetOrigin.
      worker.postMessage({
        type: "run",
        params: workerParams,
        initialAbort: serializeInitialAbort(params.opts.abortSignal),
      });
      // oxlint-enable unicorn/require-post-message-target-origin
    } catch (error) {
      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    }
  });
}
