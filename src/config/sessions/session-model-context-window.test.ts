import type { AgentMessage } from "@openclaw/agent-core";
import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { projectSessionModelContext } from "./session-model-context-read.js";
import {
  selectBoundedModelRequests,
  type ModelContextRequest,
} from "./session-model-context-window.js";

function request(seq: number, message: AgentMessage): ModelContextRequest {
  return {
    entry: {
      type: "message",
      seq,
      id: `entry-${seq}`,
      parentId: seq > 0 ? `entry-${seq - 1}` : null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    },
    omitCheckpoint: false,
  };
}

function sizing(bytes: number[]) {
  return (requests: readonly ModelContextRequest[]) =>
    new Map(requests.map(({ entry }) => [entry, bytes[entry.seq]!]));
}

it("retains the last inference model when command history and provider output leave the bounded window", () => {
  const entries = [
    request(0, makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] })).entry,
    request(
      1,
      makeAgentAssistantMessage({
        provider: "openclaw",
        model: "command",
        content: [{ type: "text", text: "Command completed" }],
      }),
    ).entry,
    request(2, { role: "user", content: "next turn", timestamp: 2 }).entry,
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
    request(0, { role: "user", content: "older history", timestamp: 0 }),
    request(1, { role: "user", content: "current request", timestamp: 1 }),
    request(
      2,
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        stopReason: "toolUse",
      }),
    ),
    request(3, {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "large result" }],
      timestamp: 2,
      isError: false,
    }),
    request(4, makeAgentAssistantMessage({ content: [{ type: "text", text: "final reply" }] })),
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
      seq: 0,
      id: "boundary",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    },
    omitCheckpoint: false,
  };
  const requests = [
    boundary,
    ...[1, 2, 3].map((seq) =>
      request(seq, { role: "user", content: `request ${seq}`, timestamp: seq }),
    ),
  ];
  expect(
    selectBoundedModelRequests(requests, sizing([100, 400, 400, 400]), {
      maxBytes: 1000,
      maxEvents: 3,
    }),
  ).toEqual([boundary, ...requests.slice(-2)]);
});

it.each([
  { prefixBytes: 0, selected: [2, 3, 4] },
  { prefixBytes: 100, selected: [3, 4] },
])(
  "keeps the absolute byte cutoff with $prefixBytes discarded bytes",
  ({ prefixBytes, selected }) => {
    const requests = [1, 2, 3, 4].map((seq) =>
      request(seq, { role: "user", content: `request ${seq}`, timestamp: seq }),
    );
    expect(
      selectBoundedModelRequests(
        requests,
        sizing([0, 300, 300, 300, 300]),
        { maxEvents: 4, maxBytes: 1000 },
        { count: 1, bytes: prefixBytes, hasUser: true, pairing: new Map() },
      ).map(({ entry }) => entry.seq),
    ).toEqual(selected);
  },
);

it("uses atomic headroom when the newest user turn starts in the discarded prefix", () => {
  const requests = [1, 2, 3, 4].map((seq) =>
    request(seq, makeAgentAssistantMessage({ content: [{ type: "text", text: `reply ${seq}` }] })),
  );
  expect(
    selectBoundedModelRequests(
      requests,
      sizing([0, 300, 300, 300, 300]),
      { maxEvents: 4, maxBytes: 1000 },
      { count: 1, bytes: 100, hasUser: true, pairing: new Map() },
    ).map(({ entry }) => entry.seq),
  ).toEqual([2, 3, 4]);
});
