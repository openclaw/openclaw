import { runExec } from "../../process/exec.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveSlackHandlerContext,
  PluginInteractiveTelegramHandlerContext,
} from "../types.js";

const GMAIL_THREAD_ID_RE = /^[a-f0-9]{16}$/;

type BuiltInInteractiveDispatchParams =
  | {
      channel: "telegram";
      data: string;
      respond: PluginInteractiveTelegramHandlerContext["respond"];
    }
  | {
      channel: "discord";
      data: string;
      respond: PluginInteractiveDiscordHandlerContext["respond"];
    }
  | {
      channel: "slack";
      data: string;
      respond: PluginInteractiveSlackHandlerContext["respond"];
    };

type UnreadThreadSummary = {
  id: string;
  from?: string;
  subject?: string;
  date?: string;
  labels?: string[];
};

function parseNamespaceAndPayload(data: string): { namespace: string; payload: string } | null {
  const trimmed = data.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex < 0) {
    return { namespace: trimmed, payload: "" };
  }
  return {
    namespace: trimmed.slice(0, separatorIndex),
    payload: trimmed.slice(separatorIndex + 1),
  };
}

export function parseNextThreadId(payload: string): string | null {
  const parts = payload
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "next") {
    return null;
  }
  const threadId = parts[1];
  return threadId && GMAIL_THREAD_ID_RE.test(threadId) ? threadId : null;
}

async function sendBuiltInInteractiveReply(
  params: BuiltInInteractiveDispatchParams,
  text: string,
): Promise<void> {
  if (params.channel === "telegram") {
    await params.respond.reply({ text });
    return;
  }
  if (params.channel === "discord") {
    await params.respond.reply({ text, ephemeral: true });
    return;
  }
  await params.respond.reply({ text, responseType: "ephemeral" });
}

async function markThreadRead(threadId: string): Promise<void> {
  await runExec("gog", ["gmail", "thread", "modify", threadId, "--remove", "UNREAD"], {
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

function normalizeUnreadThreadSummary(raw: unknown): UnreadThreadSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const entry = raw as {
    id?: unknown;
    from?: unknown;
    subject?: unknown;
    date?: unknown;
    labels?: unknown;
  };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!GMAIL_THREAD_ID_RE.test(id)) {
    return null;
  }

  return {
    id,
    from: typeof entry.from === "string" ? entry.from.trim() : undefined,
    subject: typeof entry.subject === "string" ? entry.subject.trim() : undefined,
    date: typeof entry.date === "string" ? entry.date.trim() : undefined,
    labels: Array.isArray(entry.labels)
      ? entry.labels.filter(
          (label): label is string => typeof label === "string" && label.trim().length > 0,
        )
      : undefined,
  };
}

function parseSearchResults(raw: string): UnreadThreadSummary[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { threads?: unknown }).threads)
      ? (parsed as { threads: unknown[] }).threads
      : [];
  return list
    .map((item) => normalizeUnreadThreadSummary(item))
    .filter((item): item is UnreadThreadSummary => Boolean(item));
}

async function loadNextUnreadThread(currentThreadId: string): Promise<UnreadThreadSummary | null> {
  const { stdout } = await runExec(
    "gog",
    [
      "gmail",
      "search",
      "is:unread",
      `-thread:${currentThreadId}`,
      "--max",
      "1",
      "--json",
      "--results-only",
    ],
    {
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );

  const [nextThread] = parseSearchResults(stdout);
  return nextThread ?? null;
}

function formatNextUnreadThreadMessage(thread: UnreadThreadSummary): string {
  const lines = ["Next unread Gmail thread", `Thread: ${thread.id}`];
  if (thread.from) {
    lines.push(`From: ${thread.from}`);
  }
  if (thread.subject) {
    lines.push(`Subject: ${thread.subject}`);
  }
  if (thread.date) {
    lines.push(`Date: ${thread.date}`);
  }
  if (thread.labels?.length) {
    lines.push(`Labels: ${thread.labels.join(", ")}`);
  }
  return lines.join("\n");
}

export async function dispatchBuiltInMailButtonsInteractiveHandler(
  params: BuiltInInteractiveDispatchParams,
): Promise<{ matched: boolean; handled: boolean }> {
  const parsed = parseNamespaceAndPayload(params.data);
  if (!parsed || parsed.namespace !== "mb") {
    return { matched: false, handled: false };
  }

  const currentThreadId = parseNextThreadId(parsed.payload);
  if (!currentThreadId) {
    await sendBuiltInInteractiveReply(
      params,
      "Mail button action was not recognized. Check the callback payload format.",
    );
    return { matched: true, handled: true };
  }

  try {
    await markThreadRead(currentThreadId);
    const nextThread = await loadNextUnreadThread(currentThreadId);
    if (!nextThread) {
      await sendBuiltInInteractiveReply(
        params,
        `Marked Gmail thread ${currentThreadId} as read. No more unread Gmail threads.`,
      );
      return { matched: true, handled: true };
    }

    await sendBuiltInInteractiveReply(params, formatNextUnreadThreadMessage(nextThread));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendBuiltInInteractiveReply(params, `Next mail action failed: ${message}`);
  }

  return { matched: true, handled: true };
}
