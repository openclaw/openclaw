import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type PluginHookBeforeAgentFinalizeEvent = {
  runId?: string;
  /** True only when this finalization path carries accepted presentation to ordinary delivery. */
  supportsFinalPresentation?: true;
  sessionId: string;
  sessionKey?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  transcriptPath?: string;
  stopHookActive: boolean;
  lastAssistantMessage?: string;
  messages?: unknown[];
};

export type PluginHookBeforeAgentFinalizeResult = {
  /** Optional presentation for this candidate only; discarded when finalization requests revision. */
  finalPresentation?: ReplyPayload["presentation"];
  /**
   * continue: accept normal finalization.
   * revise: block finalization and ask the harness for another model pass.
   * finalize: force finalization even if another hook requested revision.
   */
  action?: "continue" | "revise" | "finalize";
  reason?: string;
  retry?: {
    instruction: string;
    idempotencyKey?: string;
    maxAttempts?: number;
  };
};
