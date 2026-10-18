import type { ReplyToolAuthorityRoute } from "../../sessions/session-controller.contracts.js";
import { prepareFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority.types.js";

export async function resolveFollowupRunToolAuthorityFingerprintAsync(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): Promise<string> {
  const prepared = await prepareFollowupRunToolAuthorityFingerprint(snapshot, route);
  try {
    return prepared.read();
  } finally {
    prepared.release();
  }
}
