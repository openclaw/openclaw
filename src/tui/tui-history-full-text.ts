import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Full-message reads run a few at a time so long sessions do not flood the backend. */
const TUI_FULL_MESSAGE_READ_CONCURRENCY = 4;

const DISPLAY_CAP_MARKER = "\n...(truncated)...";
const UNAVAILABLE_MARKER = "\n...(truncated; the full reply could not be loaded)...";

/** Reads one stored message; resolves to a `chat.message.get`-shaped result. */
export type TuiFullMessageReader = (messageId: string) => Promise<unknown>;

function displayCappedAssistantId(message: unknown): string | undefined {
  const row = asOptionalRecord(message);
  const meta = asOptionalRecord(row?.["__openclaw"]);
  if (row?.role !== "assistant" || meta?.truncated !== true || meta.reason !== "display-cap") {
    return undefined;
  }
  return typeof meta.id === "string" && meta.id ? meta.id : undefined;
}

function replaceMarker(text: string): string | undefined {
  return text.endsWith(DISPLAY_CAP_MARKER)
    ? `${text.slice(0, -DISPLAY_CAP_MARKER.length)}${UNAVAILABLE_MARKER}`
    : undefined;
}

/** Keep the capped preview, but say that the rest could not be loaded. */
function markUnavailable(message: unknown): unknown {
  const row = asOptionalRecord(message);
  if (!row) {
    return message;
  }
  if (typeof row.content === "string") {
    const content = replaceMarker(row.content);
    return content === undefined ? message : { ...row, content };
  }
  if (!Array.isArray(row.content)) {
    return message;
  }
  let changed = false;
  const content = row.content.map((value: unknown) => {
    const block = asOptionalRecord(value);
    const text = typeof block?.text === "string" ? replaceMarker(block.text) : undefined;
    if (!block || text === undefined) {
      return value;
    }
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...row, content } : message;
}

async function readFullMessage(
  message: unknown,
  messageId: string,
  read: TuiFullMessageReader,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  signal?.throwIfAborted();
  try {
    const result = asOptionalRecord(await read(messageId));
    const full = result?.ok === true ? asOptionalRecord(result.message) : undefined;
    return full ?? markUnavailable(message);
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    return markUnavailable(message);
  }
}

/**
 * History rows are capped for transport. Replace capped assistant replies with the
 * stored message so a reopened session shows what the live stream showed.
 */
export async function loadFullTextForCappedHistory(
  history: unknown,
  read: TuiFullMessageReader,
  signal?: AbortSignal,
): Promise<unknown> {
  const record = asOptionalRecord(history);
  const messages = record?.messages;
  if (!record || !Array.isArray(messages)) {
    return history;
  }
  const next = await loadFullTextForCappedMessages(messages, read, signal);
  return next === messages ? history : { ...record, messages: next };
}

/** Returns the same array when no row is display-capped. */
export async function loadFullTextForCappedMessages(
  messages: readonly unknown[],
  read: TuiFullMessageReader,
  signal?: AbortSignal,
): Promise<readonly unknown[]> {
  const targets: Array<{ index: number; messageId: string }> = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageId = displayCappedAssistantId(messages[index]);
    if (messageId) {
      targets.push({ index, messageId });
    }
  }
  if (targets.length === 0) {
    return messages;
  }
  const next = [...messages];
  let cursor = 0;
  const worker = async () => {
    for (let target = targets[cursor++]; target; target = targets[cursor++]) {
      next[target.index] = await readFullMessage(
        messages[target.index],
        target.messageId,
        read,
        signal,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TUI_FULL_MESSAGE_READ_CONCURRENCY, targets.length) }, worker),
  );
  return next;
}
