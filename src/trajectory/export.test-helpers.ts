import fs from "node:fs";
import path from "node:path";
import type { Message, Usage } from "openclaw/plugin-sdk/llm";
import type { TrajectoryEvent } from "./types.js";

const zeroCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const emptyUsage: Usage = { ...zeroCounts, totalTokens: 0, cost: { ...zeroCounts, total: 0 } };
const textContent = (text: string): [{ type: "text"; text: string }] => [{ type: "text", text }];

export const createLargeTrajectoryUsage = () => ({
  input: 384_954,
  output: 5_624,
  cacheRead: 333_824,
  reasoningTokens: 2_038,
  total: 724_402,
});

export const userMessage = (content: string): Message => ({ role: "user", content, timestamp: 1 });

export const assistantMessage = (
  content: Extract<Message, { role: "assistant" }>["content"],
): Message => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: 2,
});

export const assistantText = (text: string) => assistantMessage(textContent(text));

const toolResultMessage = (text: string): Message => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: textContent(text),
  isError: false,
  timestamp: 3,
});

export const sessionHeader = (workspaceDir: string, id = "session-1") => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-04-01T05:46:39.000Z",
  cwd: workspaceDir,
});

export const messageEntry = (
  id: string,
  parentId: string | null | undefined,
  message: Message,
  second = 41,
) => ({ type: "message", id, parentId, timestamp: `2026-04-01T05:46:${second}.000Z`, message });

export const writeEntries = (sessionFile: string, entries: readonly unknown[]): void =>
  fs.writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

const readCall = (filePath: string): Message =>
  assistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: { filePath } }]);

export const simpleSessionEntries = (
  workspaceDir: string,
  params: { userEntryTimestamp?: string | number; userMessage?: Message } = {},
) => [
  sessionHeader(workspaceDir),
  {
    ...messageEntry("entry-user", null, params.userMessage ?? userMessage("hello"), 40),
    timestamp: params.userEntryTimestamp ?? "2026-04-01T05:46:40.000Z",
  },
  messageEntry("entry-assistant", "entry-user", assistantText("done")),
];

const sessionWriter =
  <Args extends unknown[]>(build: (directory: string, ...args: Args) => readonly unknown[]) =>
  (sessionFile: string, ...args: Args): void =>
    writeEntries(sessionFile, build(path.dirname(sessionFile), ...args));

export const writeSimpleSessionFile = sessionWriter(simpleSessionEntries);
export const writeToolCallOnlySessionFile = sessionWriter((directory: string) => [
  sessionHeader(directory),
  messageEntry("entry-assistant", null, readCall("README.md")),
]);

export const toolCallSessionEntries = (
  workspaceDir: string,
  toolResultText = "README contents",
) => [
  { ...sessionHeader(workspaceDir), title: "Trajectory Test" },
  messageEntry("entry-user", null, userMessage("hello"), 40),
  messageEntry(
    "entry-tool-call",
    "entry-user",
    readCall(path.join(workspaceDir, "skills", "weather", "SKILL.md")),
  ),
  messageEntry("entry-tool-result", "entry-tool-call", toolResultMessage(toolResultText), 42),
  messageEntry("entry-assistant", "entry-tool-result", assistantText("done"), 43),
];

export const writeToolCallSessionFile = sessionWriter(toolCallSessionEntries);

export function readEvents(outputDir: string): TrajectoryEvent[] {
  return fs
    .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as TrajectoryEvent);
}

export function createRuntimeEvent(
  type: string,
  overrides: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session-1",
    source: "runtime",
    type,
    ts: "2026-04-22T08:00:00.000Z",
    seq: 1,
    sessionId: "session-1",
    ...overrides,
  };
}

export function runtimeAttemptEvents(
  rows: ReadonlyArray<readonly [type: string, runId: string, data?: Record<string, unknown>]>,
): TrajectoryEvent[] {
  return rows.map(([type, runId, data], index) =>
    createRuntimeEvent(type, {
      seq: index + 1,
      sourceSeq: index + 1,
      runId,
      ...(data ? { data } : {}),
    }),
  );
}

export function runtimeSeries(
  rows: Array<[string, Record<string, unknown>, number?, Partial<TrajectoryEvent>?]>,
) {
  return rows.map(([type, data, seconds, overrides], index) =>
    createRuntimeEvent(type, {
      data,
      ts: new Date(Date.parse("2026-04-22T08:00:00Z") + (seconds ?? index) * 1000).toISOString(),
      seq: index + 1,
      sourceSeq: index + 1,
      ...overrides,
    }),
  );
}
