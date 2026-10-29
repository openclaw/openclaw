import type { AgentMessage } from "@openclaw/agent-core";
import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { projectSessionModelContext } from "./session-model-context-read.js";
import {
  selectBoundedModelRequests,
  type ModelContextRequest,
} from "./session-model-context-window.js";

const timestamp = "2026-01-01T00:00:00.000Z";
function entryBase(seq: number) {
  return { seq, id: `entry-${seq}`, parentId: seq > 0 ? `entry-${seq - 1}` : null, timestamp };
}
const request = (seq: number, message: AgentMessage): ModelContextRequest => ({
  entry: { ...entryBase(seq), type: "message", message },
  omitCheckpoint: false,
});

function sizing(bytes: number[]) {
  return (requests: readonly ModelContextRequest[]) =>
    new Map(requests.map(({ entry }) => [entry, bytes[entry.seq]!]));
}

const user = (seq: number, content = `request ${seq}`) =>
  request(seq, { role: "user", content, timestamp: seq });
const assistant = (
  seq: number,
  text: string,
  overrides: Partial<Parameters<typeof makeAgentAssistantMessage>[0]> = {},
) => request(seq, makeAgentAssistantMessage({ content: [{ type: "text", text }], ...overrides }));
function selectSeqs(requests: ModelContextRequest[], prefixBytes: number) {
  return selectBoundedModelRequests(
    requests,
    sizing([0, 300, 300, 300, 300]),
    { maxEvents: 4, maxBytes: 1000 },
    { count: 1, bytes: prefixBytes, hasUser: true, pairing: new Map() },
  ).map(({ entry }) => entry.seq);
}

it("retains the last inference model when command history and provider output leave the bounded window", () => {
  const entries = [
    assistant(0, "answer").entry,
    assistant(1, "Command completed", { provider: "openclaw", model: "command" }).entry,
    user(2, "next turn").entry,
  ];
  const context = projectSessionModelContext(
    {
      header: { type: "session", id: "bounded-model", version: 4 },
      entries,
      version: { generation: null, rawSeq: 2, updatedAt: 2 },
      readModelEntries: (requests) => new Map(requests.map(({ entry }) => [entry, entry])),
      readModelEntrySizes: (requests) => new Map(requests.map(({ entry }) => [entry, 100])),
    },
    { maxBytes: 1000, maxEvents: 1 },
  );
  expect(context.events).toEqual([
    { type: "session", id: "bounded-model", version: 4 },
    expect.objectContaining({ type: "model_change", provider: "openai", modelId: "test-model" }),
    expect.objectContaining({
      type: "message",
      message: { role: "user", content: "next turn", timestamp: 2 },
    }),
  ]);
});

it("preserves a newest tool turn using headroom when its final reply arrives", () => {
  const requests = [
    user(0, "older history"),
    user(1, "current request"),
    assistant(2, "", {
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      stopReason: "toolUse",
    }),
    request(3, {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "large result" }],
      timestamp: 2,
      isError: false,
    }),
    assistant(4, "final reply"),
  ];
  const readSizes = sizing([4000, 500, 1000, 7500, 300]);
  const limits = { maxBytes: 10_000, maxEvents: 100 };
  expect(selectBoundedModelRequests(requests.slice(0, -1), readSizes, limits)).toEqual(
    requests.slice(1, -1),
  );
  expect(selectBoundedModelRequests(requests, readSizes, limits)).toEqual(requests.slice(1));
});

it("reserves the compaction event slot before deciding that history exceeds the byte cap", () => {
  const boundary: ModelContextRequest = {
    entry: {
      type: "compaction",
      ...entryBase(0),
      id: "boundary",
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    },
    omitCheckpoint: false,
  };
  const requests = [boundary, ...[1, 2, 3].map((seq) => user(seq))];
  expect(
    selectBoundedModelRequests(requests, sizing([100, 400, 400, 400]), {
      maxBytes: 1000,
      maxEvents: 3,
    }),
  ).toEqual([boundary, ...requests.slice(-2)]);
});

it.each([
  { prefixBytes: 0, reply: false, selected: [2, 3, 4] },
  { prefixBytes: 100, reply: false, selected: [3, 4] },
  { prefixBytes: 100, reply: true, selected: [2, 3, 4] },
])(
  "keeps byte cutoff and atomic headroom (prefix: $prefixBytes, reply: $reply)",
  ({ prefixBytes, reply, selected }) => {
    const requests = [1, 2, 3, 4].map((seq) =>
      reply ? assistant(seq, `reply ${seq}`) : user(seq),
    );
    expect(selectSeqs(requests, prefixBytes)).toEqual(selected);
  },
);
