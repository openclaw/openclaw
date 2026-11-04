import { t } from "../../i18n/index.ts";
import { buildChatMarkdown } from "../../pages/chat/export.ts";
import { loadCompleteChatHistory } from "../chat/complete-history.ts";
import { copyToClipboard } from "../clipboard.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { resolveSessionNavigationAgentId } from "./route-navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import type { SessionNavigationTarget } from "./session-menu-navigation.ts";

export async function copySessionMarkdown<TRouteId extends string>(
  params: SessionNavigationTarget<TRouteId>,
): Promise<boolean> {
  if (!params.isCurrent()) {
    throw new Error(t("sessionsView.copyTranscriptChanged"));
  }
  const { context, session } = params;
  const gateway = context.gateway;
  const client = gateway.snapshot.client;
  const access = readSessionMethodAccess(gateway.snapshot, {
    method: "chat.history",
    requiredScope: "operator.read",
    sessionScope: true,
  });
  if (!access.allowed || !client) {
    throw new Error(access.allowed ? t("sessionsView.actionRequiresConnection") : access.reason);
  }
  const agentId =
    parseAgentSessionKey(session.key)?.agentId ??
    resolveSessionNavigationAgentId(context, params.agentId);
  const hello = gateway.snapshot.hello;
  const isCurrent = () =>
    params.isCurrent() &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.hello === hello;
  const messages = await loadCompleteChatHistory({
    client,
    sessionKey: session.key,
    sessionId: session.sessionId,
    agentId,
    isCurrent,
  });
  const assistantName =
    context.agents.state.agentsList?.agents.find((agent) => agent.id === agentId)?.name ??
    "OpenClaw";
  const markdown = buildChatMarkdown(messages, assistantName);
  if (!markdown) {
    throw new Error(t("chat.commandResults.emptyExport"));
  }
  return copyToClipboard(markdown, isCurrent);
}
