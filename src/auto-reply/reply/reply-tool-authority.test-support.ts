import type { ReplyToolAuthorityRoute } from "./reply-run-registry.contracts.js";
import {
  prepareFollowupRunToolAuthorityFingerprint,
  type ReplyToolAuthorityInput,
} from "./reply-tool-authority.js";

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
