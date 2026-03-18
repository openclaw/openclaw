import type { CliDeps } from "../../cli/deps.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDelegatedTaskRequestHandler } from "../delegated-http.js";
import { dispatchDetachedAgentTurn } from "./isolated-agent-dispatch.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayDelegatedTaskRequestHandler(params: {
  deps: CliDeps;
  log: SubsystemLogger;
}) {
  return createDelegatedTaskRequestHandler({
    log: params.log,
    runTask: ({ task, targetAgentId, message, observer }) =>
      dispatchDetachedAgentTurn({
        deps: params.deps,
        log: params.log,
        value: {
          // The delegated HTTP boundary is generic across first-class agents.
          name: `Delegated ${task.execution.runtime} Task ${task.task_id}`,
          message,
          agentId: targetAgentId,
          wakeMode: "now",
          sessionKey:
            task.execution.runtime === "subagent"
              ? `delegated-subagent:${task.task_id}`
              : `delegated-acpx:${task.task_id}`,
          deliver: false,
          channel: "last",
        },
        observer: {
          onStarted: () => {
            observer.onStarted();
          },
          onFinished: ({ result }) => {
            observer.onFinished(result);
          },
          onError: ({ error }) => {
            observer.onError(error);
          },
        },
      }),
  });
}
