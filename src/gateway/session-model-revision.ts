import { createHash } from "node:crypto";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import {
  chatMetadataSessionFields,
  type ChatMetadataSessionEntry,
} from "./server-methods/chat-metadata-contract.js";

/** Compare saved and prepared native catalog inputs without exposing private account locators. */
export function sessionModelRevision(
  entry: ChatMetadataSessionEntry | undefined,
  workerInference?: "worker",
  runtimeOwnership?: AgentHarnessSessionRuntimeOwnership | null,
): string | undefined {
  // Native bindings live outside the row; only their owner can certify an unchanged selection.
  if (resolveSessionPinnedHarnessId(entry) && runtimeOwnership === undefined) {
    return undefined;
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        ...chatMetadataSessionFields.map((field) => entry?.[field]),
        workerInference,
        runtimeOwnership?.auth,
        runtimeOwnership?.modelRef?.provider,
        runtimeOwnership?.modelRef?.model,
      ]),
    )
    .digest("base64url");
}
