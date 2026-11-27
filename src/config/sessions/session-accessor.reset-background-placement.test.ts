import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-reset-background-placement-");
let storePath: string;

beforeEach(() => {
  storePath = fixture.storePath();
});

function appendMessage(
  scope: { sessionId: string; sessionKey: string; storePath: string },
  eventId: string,
  parentId: string | null,
  message: Record<string, unknown>,
) {
  const appended = appendTranscriptMessageSync(scope, { eventId, message, parentId });
  expect(appended.ok).toBe(true);
}

it.each(["idle", "daily"] as const)(
  "keeps the tail through a %s reset after a background result was placed",
  async (reason) => {
    const scope = {
      sessionId: "placed-background-session",
      sessionKey: `agent:main:placed-background-${reason}`,
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    appendMessage(scope, "user-1", null, { role: "user", content: "start the job", timestamp: 1 });
    appendMessage(scope, "assistant-1", "user-1", {
      role: "assistant",
      content: [{ type: "text", text: "started" }],
      provider: "anthropic",
      model: "claude-test",
      stopReason: "stop",
      timestamp: 2,
    });
    // A background job's result waits outside model context until the next request places it.
    appendMessage(scope, "result-1", "assistant-1", {
      role: "assistant",
      content: [{ type: "text", text: "job finished" }],
      provider: "openclaw",
      model: "automation-result",
      stopReason: "stop",
      excludeFromContext: true,
      openclawModelPlacement: "pending",
      timestamp: 3,
    });
    await expect(
      appendTranscriptEvent(scope, {
        type: "custom",
        id: "placement-1",
        parentId: "result-1",
        timestamp: new Date(4).toISOString(),
        customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
        data: { afterEntryId: "result-1", resultEntryIds: ["result-1"] },
      }),
    ).resolves.toBe(true);
    appendMessage(scope, "user-2", "placement-1", {
      role: "user",
      content: "what did it say?",
      timestamp: 5,
    });
    appendMessage(scope, "assistant-2", "user-2", {
      role: "assistant",
      content: [{ type: "text", text: "it finished" }],
      provider: "anthropic",
      model: "claude-test",
      stopReason: "stop",
      timestamp: 6,
    });

    // The automatic reset preserves the recent tail; an explicit /new clears instead.
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      buildNextEntry: () => ({ sessionId: scope.sessionId, updatedAt: 20 }),
      resetBoundary: { context: "preserve-tail", reason, cwd: "/tmp/workspace" },
    });

    const events = await loadTranscriptEvents(scope);
    const boundary = events.find((event) => isRecord(event) && event.type === "reset");
    // The reset commits and keeps the recent conversation, so the next message gets a reply.
    expect(boundary).toMatchObject({ reason, parentId: "assistant-2", firstKeptEntryId: "user-1" });
  },
);
