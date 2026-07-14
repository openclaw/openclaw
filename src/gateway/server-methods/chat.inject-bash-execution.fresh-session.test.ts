/**
 * Guardrail: injecting a `!` result into a session with no completed first turn
 * must fail with an actionable message. The operator is looking at an open TUI
 * session, so a bare "session not found" reads as a routing bug instead of the
 * real precondition (the first turn creates the durable entry and rewrites the
 * transcript, discarding pre-turn rows).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { injectBashExecutionTranscriptMessage } from "./chat.js";
import {
  mockSessionWithoutDurableEntry,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";

describe("chat.injectBashExecution fresh-session guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
  });

  it("rejects a session with no durable entry with an actionable error", async () => {
    const sessionKey = mockSessionWithoutDurableEntry();

    const result = await injectBashExecutionTranscriptMessage({
      sessionKey,
      command: "uname -a",
      output: "Linux rpi4 aarch64",
      exitCode: 0,
      excludeFromContext: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "session has no history yet; send the agent a message first",
    });
  });
});
