import type { AgentMessage } from "@openclaw/agent-core";
import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
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
