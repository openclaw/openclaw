import { buildRuntimeContextCustomMessage } from "../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Append a bounded fact to the ordinary transcript without making it a user turn. */
export async function appendSessionRuntimeContext(params: {
  scope: SessionAccessScope & { storePath: string; sessionId: string; lifecycleRevision?: string };
  cfg: OpenClawConfig;
  content: string;
  idempotencyKey: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const message = buildRuntimeContextCustomMessage(
    sliceToolResultTextToBudget(params.content, 2000),
  );
  if (!message) {
    return;
  }
  params.assertCurrent?.();
  const result = await persistSessionTranscriptTurn(params.scope, {
    config: params.cfg,
    expectedSessionId: params.scope.sessionId,
    expectedLifecycleRevision: params.scope.lifecycleRevision ?? null,
    assertCurrent: params.assertCurrent,
    touchSessionEntry: false,
    messages: [
      {
        message: { ...message, idempotencyKey: params.idempotencyKey },
        idempotencyLookup: "scan",
      },
    ],
  });
  if (result.rejectedReason) {
    throw new Error("Session changed before its runtime context could be recorded");
  }
}
