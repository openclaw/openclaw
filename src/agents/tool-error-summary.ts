/**
 * Compact tool error summary types.
 *
 * Stores failure metadata used by transcripts, retry behavior, and mutation recovery logic.
 */
import type { FileTarget } from "./tool-mutation.js";
export { isExecLikeToolName } from "./exec-tool-names.js";

export type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  errorCode?: string;
  error?: string;
  timedOut?: boolean;
  middlewareError?: boolean;
  mutatingAction?: boolean;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};
