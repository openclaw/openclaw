/**
 * Slack AI Assistant API helpers.
 *
 * These methods integrate with Slack's "Agents & AI Apps" feature to provide
 * loading states, suggested prompts, and thread titles for AI-powered apps.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps
 */

import type { WebClient } from "@slack/web-api";
import { logVerbose } from "../globals.js";

export type AssistantStatusParams = {
  client: WebClient;
  channelId: string;
  threadTs: string;
  status: string;
};

/**
 * Set the assistant loading status (e.g., "is thinking...", "is searching...").
 * Requires the `assistant:write` scope and "Agents & AI Apps" enabled in the Slack app.
 *
 * @returns true if successful, false if the API call failed (logged but not thrown)
 */
export async function setAssistantStatus(params: AssistantStatusParams): Promise<boolean> {
  const { client, channelId, threadTs, status } = params;
  try {
    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
    return true;
  } catch (err) {
    // Log but don't throw - assistant features are optional enhancements
    logVerbose(`slack assistant.threads.setStatus failed: ${String(err)}`);
    return false;
  }
}

/**
 * Clear the assistant loading status.
 * This is done by setting an empty status string.
 */
export async function clearAssistantStatus(
  params: Omit<AssistantStatusParams, "status">,
): Promise<boolean> {
  return setAssistantStatus({ ...params, status: "" });
}

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

/**
 * Set suggested prompts for the assistant thread.
 * Shown to users as clickable suggestions in the Slack AI interface.
 */
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

export type AssistantThreadTitleParams = {
  client: WebClient;
  channelId: string;
  threadTs: string;
  title: string;
};

/**
 * Set the title for an assistant thread.
 * Shown in the History tab of the Slack AI interface.
 */
export async function setAssistantThreadTitle(
  params: AssistantThreadTitleParams,
): Promise<boolean> {
  const { client, channelId, threadTs, title } = params;
  try {
    await client.assistant.threads.setTitle({
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    });
    return true;
  } catch (err) {
    logVerbose(`slack assistant.threads.setTitle failed: ${String(err)}`);
    return false;
  }
}
