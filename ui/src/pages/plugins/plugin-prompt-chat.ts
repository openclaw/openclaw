import type { ApplicationContext } from "../../app/context.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";

/** Uses the existing one-shot route draft; never sends the author's prompt. */
export async function openPluginPromptChat(
  context: ApplicationContext,
  pluginId: string,
  prompt: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) {
    return;
  }
  const agentId = resolveSessionNavigationAgentId(context);
  const params = { agentId };
  const access = readSessionMethodAccess(context.gateway.snapshot, {
    method: "sessions.create",
    params,
    sessionScope: true,
  });
  if (!access.allowed) {
    throw new Error(access.reason);
  }
  const created = await context.sessions.createResult(params);
  if (!created || !isCurrent()) {
    return;
  }
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: created.key,
    agentId,
    exactKey: true,
    focusComposer: true,
  });
  const search = new URLSearchParams(target.options.search);
  search.set("draft", `@${pluginId} ${prompt}`);
  context.navigate("chat", { ...target.options, search: `?${search.toString()}` });
}
