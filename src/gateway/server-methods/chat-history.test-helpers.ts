import { expectDefined } from "@openclaw/normalization-core";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

export async function createHistoryReadContext(
  overrides?: Parameters<typeof createDirectChatContext>[0],
) {
  const context = createDirectChatContext(overrides);
  await initializeSessionReadContext(context);
  await expectDefined(
    getSessionRowProjection(context),
    "history row projection",
  ).ensureMaterialized();
  return context;
}
