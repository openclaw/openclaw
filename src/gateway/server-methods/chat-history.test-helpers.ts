import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

export async function createHistoryReadContext(
  overrides?: Parameters<typeof createDirectChatContext>[0],
) {
  const context = createDirectChatContext(overrides);
  await initializeSessionReadContext(context);
  return context;
}
