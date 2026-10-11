import { randomUUID } from "node:crypto";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-contract.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionMessageRewriteOperations } from "./session-message-rewrite.worker.js";

export function executeSessionMessageRewriteOperation<
  Key extends keyof SessionMessageRewriteOperations,
>(
  worker: AgentDatabaseExecutionScope,
  agentId: string,
  command: { type: Key; input: SessionMessageRewriteOperations[Key]["input"] },
): Promise<SessionMessageRewriteOperations[Key]["output"]> {
  return executeOpenClawAgentWorkerPublication<SessionMessageRewriteOperations, Key>(worker, {
    id: randomUUID(),
    moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionMessageRewriteDomain).href,
    input: { agentId },
    command,
  });
}
