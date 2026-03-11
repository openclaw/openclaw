import type { CliDeps } from "../../cli/deps.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { createAngelaTaskRequestHandler } from "../angela-http.js";
import { dispatchDetachedAgentTurn } from "./isolated-agent-dispatch.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayAngelaRequestHandler(params: { deps: CliDeps; log: SubsystemLogger }) {
  return createAngelaTaskRequestHandler({
    log: params.log,
    runTask: ({ task, targetAgentId, message, observer }) =>
      dispatchDetachedAgentTurn({
        deps: params.deps,
        log: params.log,
        value: {
          name: `Angela Task ${task.task_id}`,
          message,
          agentId: targetAgentId,
          wakeMode: "now",
          sessionKey: `angela:${task.task_id}`,
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
