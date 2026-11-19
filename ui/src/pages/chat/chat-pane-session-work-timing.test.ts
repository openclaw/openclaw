/* @vitest-environment jsdom */

import { afterEach, assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { nativeMessage } from "./chat-thread-fixtures.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps completed-work timing when the retained roster omits the observed conversation", async () => {
  const row: GatewaySessionRow = {
    key: "agent:main:dashboard:observed-work",
    agentId: "main",
    sessionId: "observed-work",
    kind: "direct",
    label: "Observed work",
    status: "done",
    lastRunId: "work-run",
  };
  const history = {
    sessionId: row.sessionId,
    sessionInfo: row,
    messages: [
      nativeMessage("user", "Review the report", 1_000, {
        id: "request",
        seq: 1,
        idempotencyKey: "work-run:user",
      }),
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-report",
        runId: "work-run",
        content: "Report read",
        timestamp: 2_000,
        __openclaw: { seq: 2 },
      },
      {
        role: "assistant",
        runId: "work-run",
        content: "Report reviewed",
        __openclaw: { seq: 3, recordTimestampMs: 181_000 },
      },
    ],
  };
  const { context, mount } = createMountedPanes([row], "main", undefined, {
    "chat.history": async () => history,
    "chat.startup": async () => history,
  });
  const pane = mount(row.key);
  await refreshPane(pane);
  vi.spyOn(context.sessions, "presentation", "get").mockReturnValue({
    result: sessionsResult([], 1),
    agentId: "main",
  });
  pane.state.sessionsResult = context.sessions.presentation.result;
  const layout = pane.render().layout;
  assert(layout, "Expected chat layout");
  const transcript = createTestTranscript();
  const view = mountChatThread({ ...layout.primary.chat, showToolCalls: true }, transcript);
  onTestFinished(() => {
    view.unmount();
    transcript.dispose();
  });
  transcript.start();
  await flushDeferredRowPrune();
  expect(view.container.querySelector(".chat-activity-group__label")?.textContent).toBe(
    "Worked for 3m",
  );
});
