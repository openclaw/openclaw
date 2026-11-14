/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("retires a kept first read when a stronger change follows an append", async () => {
  const row: GatewaySessionRow = {
    key: "agent:main:dashboard:first-read",
    agentId: "main",
    sessionId: "first-read-session",
    kind: "direct",
    updatedAt: 1,
  };
  const text = (value: string) => ({ role: "assistant", content: value });
  const reads: Array<ReturnType<typeof createDeferred<ChatHistoryResult>>> = [];
  const history = vi.fn<GatewayRequestHandler>(() => {
    const read = createDeferred<ChatHistoryResult>();
    reads.push(read);
    return read.promise;
  });
  const { sessions, mount } = createMountedPanes([row], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
  });
  await sessions.refresh({ agentId: "main", force: true });
  const pane = mount(row.key);
  const first = loadChatHistory(pane.state, { startup: true, deferBranches: true });
  await vi.waitFor(() => expect(reads).toHaveLength(1));

  // An append keeps the first read; a later reset must still retire it.
  void loadChatHistory(pane.state, { supersedeInFlight: "append", deferBranches: true });
  void loadChatHistory(pane.state, { supersedeInFlight: true, deferBranches: true });
  reads[0]!.resolve({
    messages: [text("Before the reset")],
    sessionId: row.sessionId,
    sessionInfo: row,
  });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(pane.state.chatMessages).toEqual([]);

  reads[1]!.resolve({
    messages: [text("After the reset")],
    sessionId: row.sessionId,
    sessionInfo: row,
  });
  await first;
  expect(pane.state.chatMessages).toEqual([text("After the reset")]);
});
