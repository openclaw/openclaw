import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiBackend } from "./tui-backend.js";

/** Read exact history before interpreting the shipped qualified-global Home alias. */
export async function readTuiSessionHistory(params: {
  client: Pick<TuiBackend, "loadHistory">;
  sessionKey: string;
  agentId: string;
  limit: number;
  isCurrent: () => boolean;
}): Promise<{ history: unknown; legacyHistoryKey?: string } | undefined> {
  const { client, sessionKey, agentId, limit, isCurrent } = params;
  const parsed = parseAgentSessionKey(sessionKey);
  let history = await client.loadHistory({
    sessionKey,
    ...(!parsed ? { agentId } : {}),
    limit,
  });
  if (!isCurrent()) {
    return undefined;
  }
  const initialHistory = asOptionalRecord(history);
  const sessionInfo = asOptionalRecord(initialHistory?.sessionInfo);
  if (
    parsed?.rest !== "global" ||
    !initialHistory ||
    !Array.isArray(initialHistory.messages) ||
    initialHistory.messages.length !== 0 ||
    initialHistory.sessionId !== undefined ||
    (initialHistory.sessionInfo !== undefined && !sessionInfo) ||
    sessionInfo?.sessionId !== undefined
  ) {
    return { history };
  }
  // The public history shape omits identity only for an absent row. Errors never fall back.
  if (!isCurrent()) {
    return undefined;
  }
  history = await client.loadHistory({ sessionKey: "global", agentId, limit });
  return isCurrent() ? { history, legacyHistoryKey: "global" } : undefined;
}
