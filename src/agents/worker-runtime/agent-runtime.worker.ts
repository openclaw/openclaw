import { parentPort } from "node:worker_threads";
import { onAgentEvent } from "../../infra/agent-events.js";
import { runAgentAttempt } from "../command/attempt-execution.js";
import type {
  AgentWorkerToParentMessage,
  ParentToAgentWorkerMessage,
} from "./agent-runtime.types.js";
import { serializeWorkerError } from "./errors.js";
import { restoreAgentWorkerPluginRuntime } from "./plugin-runtime.js";

function post(message: AgentWorkerToParentMessage): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads MessagePort has no targetOrigin.
  parentPort?.postMessage(message);
}

let abortController: AbortController | undefined;

parentPort?.on("message", (message: ParentToAgentWorkerMessage) => {
  if (message.type === "abort") {
    abortController?.abort(message.reason);
    return;
  }

  if (message.type !== "run") {
    return;
  }

  abortController = new AbortController();
  if (message.initialAbort) {
    abortController.abort(message.initialAbort.reason);
  }
  const stopRuntimeEventBridge = onAgentEvent((event) => {
    post({ type: "agentEvent", origin: "runtime", event });
  });
  try {
    restoreAgentWorkerPluginRuntime(message.params);
  } catch (error: unknown) {
    post(serializeWorkerError(error));
    stopRuntimeEventBridge();
    abortController = undefined;
    return;
  }
  void runAgentAttempt({
    ...message.params,
    opts: {
      ...message.params.opts,
      abortSignal: abortController.signal,
    },
    onAgentEvent: (event) => {
      post({ type: "agentEvent", origin: "callback", event });
    },
    onUserMessagePersisted: (persisted) => {
      post({ type: "userMessagePersisted", message: persisted });
    },
  })
    .then((result) => {
      post({ type: "result", result });
    })
    .catch((error: unknown) => {
      post(serializeWorkerError(error));
    })
    .finally(() => {
      stopRuntimeEventBridge();
      abortController = undefined;
    });
});
