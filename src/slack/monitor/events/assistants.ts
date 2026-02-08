import type { SlackMonitorContext } from "../context.js";
import { danger, logVerbose } from "../../../globals.js";

/**
 * Register Slack Assistants API event handlers.
 *
 * These enable the split-screen sidebar experience:
 * - `assistant_thread_started`: user opens the assistant container
 * - `assistant_thread_context_changed`: user navigates to a different channel
 *
 * Actual message handling for assistant threads is done by the existing
 * `message` event handler — DM messages route through the normal dispatch
 * pipeline automatically.
 */
export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
}) {
  const { ctx } = params;
  const client = ctx.app.client;

  // assistant_thread_started: fires when a user opens the assistant sidebar.
  // We set suggested prompts and optionally send a welcome message.
  ctx.app.event(
    "assistant_thread_started" as never,
    async ({ event, body }: { event: AssistantThreadStartedEvent; body: unknown }) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const thread = event.assistant_thread;
        const channelId = thread.channel_id;
        const threadTs = thread.thread_ts;
        const contextChannelId = thread.context?.channel_id;

        logVerbose(
          `slack: assistant thread started in ${channelId}, context channel: ${contextChannelId ?? "none"}`,
        );

        // Track this sidebar session so dispatch can post activity here.
        const userId = thread.user_id;
        ctx.sidebarSessions.set(userId, { channelId, threadTs });
        logVerbose(`slack: registered sidebar session for user ${userId}`);

        // Set status while we prepare
        try {
          await client.apiCall("assistant.threads.setStatus", {
            channel_id: channelId,
            thread_ts: threadTs,
            status: "is getting ready...",
          });
        } catch {
          // Status API may fail silently — continue anyway
        }

        // Set suggested prompts based on whether user is in a channel or not
        const prompts = contextChannelId
          ? [
              {
                title: "Summarize channel",
                message: "Summarize the recent activity in this channel.",
              },
              {
                title: "Find action items",
                message: "What action items or tasks were discussed recently?",
              },
              {
                title: "Draft a message",
                message: "Help me draft a message for this channel.",
              },
            ]
          : [
              {
                title: "What can you do?",
                message: "What tools and capabilities do you have?",
              },
              {
                title: "Check my tasks",
                message: "Show me my current Todoist tasks.",
              },
              {
                title: "Search my vault",
                message: "Search my Obsidian vault for recent notes.",
              },
            ];

        try {
          await client.apiCall("assistant.threads.setSuggestedPrompts", {
            channel_id: channelId,
            thread_ts: threadTs,
            title: contextChannelId
              ? "I can help with this channel:"
              : "What can I help with?",
            prompts,
          });
        } catch (err) {
          logVerbose(`slack: failed to set suggested prompts: ${String(err)}`);
        }

        // Clear the status (the prompts are the welcome)
        try {
          await client.apiCall("assistant.threads.setStatus", {
            channel_id: channelId,
            thread_ts: threadTs,
            status: "",
          });
        } catch {
          // ignore
        }
      } catch (err) {
        ctx.runtime.error?.(danger(`slack assistant_thread_started handler failed: ${String(err)}`));
      }
    },
  );

  // assistant_thread_context_changed: fires when user navigates to a different
  // channel while the assistant sidebar is open.  We update suggested prompts
  // to reflect the new context.
  ctx.app.event(
    "assistant_thread_context_changed" as never,
    async ({ event, body }: { event: AssistantThreadContextChangedEvent; body: unknown }) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const thread = event.assistant_thread;
        const channelId = thread.channel_id;
        const threadTs = thread.thread_ts;
        const contextChannelId = thread.context?.channel_id;

        logVerbose(
          `slack: assistant thread context changed to ${contextChannelId ?? "none"}`,
        );

        // Update suggested prompts for the new channel context
        if (contextChannelId) {
          try {
            await client.apiCall("assistant.threads.setSuggestedPrompts", {
              channel_id: channelId,
              thread_ts: threadTs,
              title: "I can help with this channel:",
              prompts: [
                {
                  title: "Summarize channel",
                  message: "Summarize the recent activity in this channel.",
                },
                {
                  title: "Find action items",
                  message: "What action items or tasks were discussed recently?",
                },
              ],
            });
          } catch (err) {
            logVerbose(`slack: failed to update suggested prompts: ${String(err)}`);
          }
        }
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack assistant_thread_context_changed handler failed: ${String(err)}`),
        );
      }
    },
  );
}

// Event payload types for Slack Assistants API
type AssistantThreadStartedEvent = {
  type: "assistant_thread_started";
  assistant_thread: {
    user_id: string;
    context?: {
      channel_id?: string;
      team_id?: string;
      enterprise_id?: string;
    };
    channel_id: string;
    thread_ts: string;
  };
  event_ts: string;
};

type AssistantThreadContextChangedEvent = {
  type: "assistant_thread_context_changed";
  assistant_thread: {
    user_id: string;
    context?: {
      channel_id?: string;
      team_id?: string;
      enterprise_id?: string;
    };
    channel_id: string;
    thread_ts: string;
  };
  event_ts: string;
};
