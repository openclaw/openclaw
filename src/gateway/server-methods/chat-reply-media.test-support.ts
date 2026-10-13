import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { loadSessionEntry } from "../session-utils.js";
import { captureWebchatReplyMediaScope } from "./chat-reply-media.js";

export async function seedWebchatReplyMediaScope(
  params: Parameters<typeof captureWebchatReplyMediaScope>[0] & { sessionEntry: SessionEntry },
) {
  const { sessionEntry, ...captureParams } = params;
  const sessionLoadOptions = { agentId: params.agentId, ...params.sessionLoadOptions };
  const target = loadSessionEntry(params.sessionKey, sessionLoadOptions);
  await replaceSessionEntry(
    {
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    },
    sessionEntry,
  );
  return captureWebchatReplyMediaScope({ ...captureParams, sessionLoadOptions });
}
