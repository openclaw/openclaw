/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("opens a busy chat whose live messages arrive during every history read", async () => {
  const row: GatewaySessionRow = {
    key: "agent:main:dashboard:busy",
    agentId: "main",
    sessionId: "busy-session",
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
    status: "running",
    activeRunIds: ["run-1"],
    lastRunId: "run-1",
  };
  const message = (seq: number) => ({
    role: "assistant",
    content: [{ type: "text", text: `Live step ${seq}` }],
    __openclaw: { id: `step-${seq}`, seq, runId: "run-1" },
  });
  const reads: Array<ReturnType<typeof createDeferred<ChatHistoryResult>>> = [];
  let readStarted = createDeferred();
  const history = vi.fn<GatewayRequestHandler>(() => {
    const read = createDeferred<ChatHistoryResult>();
    reads.push(read);
    readStarted.resolve();
    return read.promise;
  });
  const { sessions, mount, emitGatewayEvent } = createMountedPanes([row], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
  });
  await sessions.refresh({ agentId: "main", force: true });
  const pane = mount(row.key);
  // The first read of a chat this pane has never shown.
  void loadChatHistory(pane.state, { startup: true, deferBranches: true });

  // The run appends a message during each read, as a busy session does.
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  };
  let seq = 0;
  while (seq < 4) {
    seq += 1;
    await readStarted.promise;
    readStarted = createDeferred();
    emitGatewayEvent("session.message", {
      sessionKey: row.key,
      agentId: "main",
      sessionId: row.sessionId,
      phase: "message",
      hasActiveRun: true,
      session: { ...row, updatedAt: seq + 1 },
      runId: "run-1",
      message: message(seq),
      messageId: `step-${seq}`,
      messageSeq: seq,
    });
    reads.at(-1)!.resolve({
      messages: Array.from({ length: seq - 1 }, (_, index) => message(index + 1)),
      sessionId: row.sessionId,
      sessionInfo: row,
    });
    await settle();
  }

  // The chat opened from a read even though every read overlapped a new message.
  expect(isInitialChatHistoryUnavailable(pane.state)).toBe(false);
  expect(pane.state.currentSessionId).toBe(row.sessionId);
});
