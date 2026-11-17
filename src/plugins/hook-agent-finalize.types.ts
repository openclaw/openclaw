// Terminal agent-run hook payloads: finalize review and the observed run outcome.
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type PluginHookAgentEndEvent = {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
  /** Model calls the run made, when the runtime reports them. */
  modelIterations?: number;
  /** Skills the run invoked by command or read from disk, once per name, source and activation. */
  skillsUsed?: readonly {
    name: string;
    source: "bundled" | "unknown" | "workspace";
    activation: "command" | "read";
  }[];
};

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
