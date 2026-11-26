import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import type { FollowupRun } from "./queue.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

export async function withQuestionCreator(
  key: string,
  run: FollowupRun,
  test: (operation: ReturnType<typeof createReplyOperation>, fingerprint: string) => Promise<void>,
) {
  run.run.agentId = "main";
  run.run.sessionKey = key;
  // These independent logical fixtures must not share one synthetic incarnation.
  run.run.sessionId = `question-${key}`;
  const runId = "accepted-backing-work";
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const fingerprint = await operation.bindToolAuthorityRouteAsync({
    provider: run.run.provider,
    model: run.run.model,
  });
  const admission = prepareAgentRunAdmission({
    cfg: run.run.config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "question-custody-test" },
    },
  });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      {
        admittedRunContext: await admission.admit("embedded", "question-custody-test"),
        replyOperation: operation,
      },
      {
        ...run.run,
        runId,
        modelId: run.run.model,
        toolAuthorityFingerprint: fingerprint,
        abortSignal: operation.abortSignal,
      },
      undefined,
      () => test(operation, fingerprint),
    );
  } finally {
    operation.complete();
    admission.close();
  }
}
