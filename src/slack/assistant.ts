import type { WebClient } from "@slack/web-api";
import { logVerbose } from "../globals.js";

export type AssistantSuggestedPrompt = {
  title: string;
  message: string;
};

export type AssistantSuggestedPromptsParams = {
  client: WebClient;
  channelId: string;
  threadTs: string;
  title?: string;
  prompts: AssistantSuggestedPrompt[];
};

export async function setAssistantSuggestedPrompts(
  params: AssistantSuggestedPromptsParams,
): Promise<boolean> {
  const { client, channelId, threadTs, title, prompts } = params;
  try {
    await client.assistant.threads.setSuggestedPrompts({
      channel_id: channelId,
      thread_ts: threadTs,
      title: title ?? "How can I help?",
      prompts: prompts.map((p) => ({ title: p.title, message: p.message })),
    });
    return true;
  } catch (err) {
    logVerbose(`slack assistant.threads.setSuggestedPrompts failed: ${String(err)}`);
    return false;
  }
}
