/**
 * Event handlers for Slack "Agents & AI Apps" assistant events.
 *
 * Registers listeners for:
 * - `assistant_thread_started` — user opens the AI assistant panel
 * - `assistant_thread_context_changed` — user switches channels with the panel open
 *
 * These events are only fired when "Agents & AI Apps" is enabled in the Slack
 * app configuration. When disabled, the listeners are registered but never
 * invoked, so there is no impact on existing behavior.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps
 */

import type { SlackMonitorContext } from "../context.js";
import { danger, logVerbose } from "../../../globals.js";
import { setAssistantSuggestedPrompts, type AssistantSuggestedPrompt } from "../../assistant.js";
import { saveThreadContext, type AssistantThreadContext } from "../assistant-context.js";

/**
 * Shape of the `assistant_thread_started` event payload.
 * Bolt may not have typed definitions for this yet, so we define it ourselves.
 */
interface AssistantThreadStartedEvent {
  type: "assistant_thread_started";
  assistant_thread: {
    user_id: string;
    context: {
      channel_id?: string;
      team_id?: string;
      enterprise_id?: string;
    };
    channel_id: string;
    thread_ts: string;
  };
}

/**
 * Shape of the `assistant_thread_context_changed` event payload.
 */
interface AssistantThreadContextChangedEvent {
  type: "assistant_thread_context_changed";
  assistant_thread: {
    user_id: string;
    context: {
      channel_id?: string;
      team_id?: string;
      enterprise_id?: string;
    };
    channel_id: string;
    thread_ts: string;
  };
}

/** Default suggested prompts shown when a user opens the assistant panel. */
const DEFAULT_PROMPTS: AssistantSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "Summarize channel", message: "Can you summarize the recent activity in this channel?" },
  { title: "Draft a message", message: "Help me draft a message" },
];

function extractContext(
  assistantThread: AssistantThreadStartedEvent["assistant_thread"],
): AssistantThreadContext {
  return {
    channelId: assistantThread.context.channel_id ?? undefined,
    teamId: assistantThread.context.team_id ?? undefined,
    enterpriseId: assistantThread.context.enterprise_id ?? undefined,
  };
}

export function registerSlackAssistantEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // Register assistant_thread_started listener.
  // Using string event name because Bolt may not have typed definitions yet.
  (ctx.app.event as Function)(
    "assistant_thread_started",
    async ({ event, body }: { event: AssistantThreadStartedEvent; body: unknown }) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const assistantThread = event.assistant_thread;
        if (!assistantThread) {
          logVerbose("slack assistant_thread_started: missing assistant_thread payload");
          return;
        }

        const channelId = assistantThread.channel_id;
        const threadTs = assistantThread.thread_ts;
        const userId = assistantThread.user_id;

        logVerbose(
          `slack assistant_thread_started: channel=${channelId} thread=${threadTs} user=${userId}`,
        );

        // Store the thread context for later use in channel-aware responses.
        const context = extractContext(assistantThread);
        saveThreadContext(channelId, threadTs, context);

        // Set suggested prompts for the new assistant thread.
        await setAssistantSuggestedPrompts({
          client: ctx.app.client,
          channelId,
          threadTs,
          title: "How can I help?",
          prompts: DEFAULT_PROMPTS,
        });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack assistant_thread_started handler failed: ${String(err)}`),
        );
      }
    },
  );

  // Register assistant_thread_context_changed listener.
  (ctx.app.event as Function)(
    "assistant_thread_context_changed",
    async ({ event, body }: { event: AssistantThreadContextChangedEvent; body: unknown }) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const assistantThread = event.assistant_thread;
        if (!assistantThread) {
          logVerbose("slack assistant_thread_context_changed: missing assistant_thread payload");
          return;
        }

        const channelId = assistantThread.channel_id;
        const threadTs = assistantThread.thread_ts;

        logVerbose(
          `slack assistant_thread_context_changed: channel=${channelId} thread=${threadTs} ` +
            `viewingChannel=${assistantThread.context.channel_id ?? "none"}`,
        );

        // Update the stored context for this thread.
        const context = extractContext(assistantThread);
        saveThreadContext(channelId, threadTs, context);
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack assistant_thread_context_changed handler failed: ${String(err)}`),
        );
      }
    },
  );
}
