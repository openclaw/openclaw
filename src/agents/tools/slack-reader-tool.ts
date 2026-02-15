import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { SlackReaderConfig } from "../../slack/reader/types.js";
import type { AnyAgentTool } from "./common.js";
import { listReaderChannels } from "../../slack/reader/channels.js";
import { resolveReaderClient } from "../../slack/reader/client.js";
import { readReaderHistory } from "../../slack/reader/history.js";
import { searchReaderMessages } from "../../slack/reader/search.js";
import { summarizeReaderChannel } from "../../slack/reader/summarize.js";
import { readReaderThread } from "../../slack/reader/thread.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MAX_COUNT = 100;

const SlackReaderSchema = Type.Object({
  action: Type.String({
    description: "Action: channels, history, search, thread, summarize",
  }),
  workspace: Type.String({
    description: 'Workspace name (saasgroup, protaige, edubites, zenloop) or "all" for search',
  }),
  channel: Type.Optional(Type.String({ description: "Channel name or ID" })),
  query: Type.Optional(Type.String({ description: "Search query" })),
  count: Type.Optional(Type.Number({ description: "Number of results (max 100)" })),
  since: Type.Optional(Type.String({ description: "ISO date for filtering messages" })),
  threadTs: Type.Optional(Type.String({ description: "Thread timestamp" })),
  period: Type.Optional(
    Type.String({ description: "Period: today, yesterday, this_week, this_month" }),
  ),
});

function resolveSlackReaderConfig(cfg?: OpenClawConfig): SlackReaderConfig | undefined {
  const raw = (cfg as Record<string, unknown>)?.tools;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const slackReader = (raw as Record<string, unknown>).slackReader;
  if (!slackReader || typeof slackReader !== "object") {
    return undefined;
  }
  return slackReader as SlackReaderConfig;
}

function clampCount(raw?: number): number {
  if (raw === undefined || raw === null) {
    return 20;
  }
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(raw)));
}

export async function handleSlackReaderAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const readerConfig = resolveSlackReaderConfig(cfg);
  const action = readStringParam(params, "action", { required: true });
  const workspace = readStringParam(params, "workspace", { required: true });

  // Validate workspace (except for "all" in search)
  if (workspace !== "all") {
    const workspaces = readerConfig?.workspaces;
    if (!workspaces || !(workspace in workspaces)) {
      const valid = workspaces ? Object.keys(workspaces).join(", ") : "none configured";
      return jsonResult({ ok: false, error: `Unknown workspace '${workspace}'. Valid: ${valid}` });
    }
    const ws = workspaces[workspace];
    const token = ws?.botToken?.trim();
    if (!token) {
      return jsonResult({
        ok: false,
        error: `No bot token configured for workspace '${workspace}'`,
      });
    }
  }

  try {
    switch (action) {
      case "channels": {
        const client = resolveReaderClient(workspace, readerConfig ?? {});
        const channels = await listReaderChannels(client);
        return jsonResult({ ok: true, channels });
      }
      case "history": {
        const client = resolveReaderClient(workspace, readerConfig ?? {});
        const channel = readStringParam(params, "channel", { required: true });
        const count = clampCount(readNumberParam(params, "count", { integer: true }));
        const since = readStringParam(params, "since");
        const messages = await readReaderHistory(client, {
          channel,
          count,
          since: since ?? undefined,
        });
        return jsonResult({ ok: true, messages });
      }
      case "search": {
        const query = readStringParam(params, "query", { required: true });
        const count = clampCount(readNumberParam(params, "count", { integer: true }));
        const clients: Record<string, ReturnType<typeof resolveReaderClient>> = {};
        if (workspace === "all") {
          const workspaces = readerConfig?.workspaces ?? {};
          for (const [id, ws] of Object.entries(workspaces)) {
            if (ws.enabled === false || !ws.botToken?.trim()) {
              continue;
            }
            clients[id] = resolveReaderClient(id, readerConfig ?? {});
          }
        } else {
          clients[workspace] = resolveReaderClient(workspace, readerConfig ?? {});
        }
        const results = await searchReaderMessages({
          clients,
          workspace,
          query,
          count,
        });
        return jsonResult({ ok: true, results });
      }
      case "thread": {
        const client = resolveReaderClient(workspace, readerConfig ?? {});
        const channel = readStringParam(params, "channel", { required: true });
        const threadTs = readStringParam(params, "threadTs", { required: true });
        const messages = await readReaderThread(client, { channel, threadTs });
        return jsonResult({ ok: true, messages });
      }
      case "summarize": {
        const client = resolveReaderClient(workspace, readerConfig ?? {});
        const channel = readStringParam(params, "channel", { required: true });
        const period = readStringParam(params, "period", { required: true });
        const result = await summarizeReaderChannel(client, {
          channel,
          period: period as "today" | "yesterday" | "this_week" | "this_month",
        });
        if (result.empty) {
          return jsonResult({ ok: true, empty: true, summary: result.formatted });
        }
        return jsonResult({
          ok: true,
          summary: result.formatted,
          messageCount: result.messages.length,
        });
      }
      default:
        return jsonResult({ ok: false, error: `Unknown action '${action}'` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ ok: false, error: message });
  }
}

export function createSlackReaderTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const readerConfig = resolveSlackReaderConfig(options?.config);
  if (!readerConfig || readerConfig.enabled !== true) {
    return null;
  }

  return {
    label: "Slack Reader",
    name: "slack_read",
    description:
      "Search and read messages from Slack workspaces (read-only). Actions: channels (list channels), history (recent messages), search (find messages), thread (read thread), summarize (channel summary).",
    parameters: SlackReaderSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      return handleSlackReaderAction(params, options?.config ?? ({} as OpenClawConfig));
    },
  };
}
