import type { SessionEntry } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";

export async function readGatewayBeforeResetPluginHookMessages(params: {
  agentId: string;
  entry?: SessionEntry;
  sessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
    return [];
  }
  try {
    return await readSessionMessagesAsync(
      {
        agentId: params.agentId,
        sessionEntry: params.entry,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        mode: "full",
        reason: "before_reset hook payload",
      },
    );
  } catch (err) {
    logVerbose(
      `before_reset: failed to read session messages for ${params.sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return [];
  }
}
