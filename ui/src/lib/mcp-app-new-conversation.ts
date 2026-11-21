import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { McpAppMessageEventDetail } from "../components/mcp-app-security.ts";
import { buildChatApiAttachments } from "../pages/chat/attachment-api.ts";
import { releaseChatAttachmentPayloads } from "../pages/chat/attachment-payload-store.ts";
import { completeInitialSessionTurn } from "../pages/new-session/initial-session-turn-handoff.ts";
import { StartedSessionNavigation } from "../pages/new-session/started-session-navigation.ts";
import { mcpAppMessageInput } from "./mcp-app-message.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "./uploads.ts";

export async function sendMcpAppNewConversation(
  context: ApplicationContext,
  agentId: string,
  detail: McpAppMessageEventDetail,
  signal?: AbortSignal,
): Promise<boolean> {
  const client = context.gateway.snapshot.client;
  if (!client || context.gateway.snapshot.phase !== "connected") {
    return false;
  }
  const scope = gatewayPresentationScope(context.gateway).key;
  const location = context.router.getState().location;
  const intent = context.agentSelection.intentRevision;
  const turn = mcpAppMessageInput(detail.content, context);
  if (turn.attachments.length && !uploadsEnabled(context.config)) {
    releaseChatAttachmentPayloads(turn.attachments);
    throw new Error(uploadsDisabledMessage());
  }
  const current = () =>
    !signal?.aborted &&
    context.gateway.snapshot.client === client &&
    gatewayPresentationScope(context.gateway).key === scope &&
    context.router.getState().location === location &&
    context.agentSelection.intentRevision === intent;
  let released = false;
  try {
    const result = await context.sessions.createResult(
      {
        agentId,
        message: turn.text,
        attachments: buildChatApiAttachments(turn.attachments),
      },
      { signal },
    );
    if (!result) {
      return false;
    }
    await completeInitialSessionTurn({
      context,
      client,
      agentId,
      result,
      turn,
      navigation: new StartedSessionNavigation(),
      instant: undefined,
      isCurrent: current,
      clearDraft: async (release) => {
        released = true;
        if (release) {
          releaseChatAttachmentPayloads(turn.attachments);
        }
      },
      completeInBackground: () => false,
      finishNavigation: () => {},
    });
    return result.initialRun.status === "started";
  } finally {
    if (!released) {
      releaseChatAttachmentPayloads(turn.attachments);
    }
  }
}
