import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { assertRequiredWorkerSelection } from "../config/required-worker-profile.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isAgentHarnessSessionKeyOwnedBy,
  resolveMissingAgentHarnessSessionError,
} from "../sessions/agent-harness-session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";
import { invalidSessionRequest as invalid } from "./session-request-error.js";

/** Validate lifecycle and execution choices before projecting any entry mutations. */
export function validateSessionPatchAdmission(params: {
  cfg: OpenClawConfig;
  storeKey: string;
  patch: SessionsPatchParams;
  existingEntry?: SessionEntry;
  authorizedAgentHarnessId?: string;
}): ReturnType<typeof invalid> | undefined {
  const { cfg, storeKey, patch } = params;
  try {
    assertRequiredWorkerSelection(cfg, patch);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  if ("execSecurity" in patch || "execAsk" in patch) {
    return invalid(
      "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
    );
  }
  const authorizedHarnessCreation =
    params.existingEntry === undefined &&
    isAgentHarnessSessionKeyOwnedBy(storeKey, params.authorizedAgentHarnessId);
  const harnessSessionError = authorizedHarnessCreation
    ? undefined
    : resolveMissingAgentHarnessSessionError(storeKey, params.existingEntry);
  if (harnessSessionError) {
    return invalid(harnessSessionError);
  }
  if (typeof patch.archived === "boolean") {
    if (!params.existingEntry?.sessionId) {
      return invalid(`session not found: ${storeKey}`);
    }
    if (patch.expectedSessionId === undefined) {
      return invalid(`expectedSessionId required for session lifecycle patch: ${storeKey}`);
    }
  }
  if (
    ("model" in patch || "agentRuntime" in patch) &&
    isModelSelectionLocked(params.existingEntry)
  ) {
    return invalid(MODEL_SELECTION_LOCKED_MESSAGE);
  }
  if (typeof patch.agentRuntime === "string" && typeof patch.model !== "string") {
    return invalid("agentRuntime requires an explicit canonical provider/model selection");
  }
  return undefined;
}
