import { createHash } from "node:crypto";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import {
  chatMetadataSessionFields,
  type ChatMetadataSessionEntry,
} from "./server-methods/chat-metadata-contract.js";

/** Compare saved catalog inputs without exposing private account locators. */
export function sessionModelRevision(
  entry: ChatMetadataSessionEntry | undefined,
  workerInference?: "worker",
): string | undefined {
  // Native owners can replace private model bindings without changing the saved row.
  if (resolveSessionPinnedHarnessId(entry)) {
    return undefined;
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        ...chatMetadataSessionFields.map((field) => entry?.[field]),
        workerInference,
      ]),
    )
    .digest("base64url");
}
