/**
 * Guardrail: injecting a `!` result into a session with no completed first turn
 * must fail with an actionable message. The operator is looking at an open TUI
 * session, so a bare "session not found" reads as a routing bug instead of the
 * real precondition (the first turn creates the durable entry and rewrites the
 * transcript, discarding pre-turn rows).
 *
 * Owns its session-utils mock instead of reusing deleted-agent-guard.test-helpers:
 * that helper's hoisted mock instance is shared per worker, and two test files
 * mutating one mock instance races under `--isolate=false`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { injectBashExecutionTranscriptMessage } from "./chat-inject-handlers.js";

const freshSessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: freshSessionMocks.loadSessionEntry,
  };
});

describe("chat.injectBashExecution fresh-session guard", () => {
  beforeEach(() => {
    freshSessionMocks.loadSessionEntry.mockReset();
  });

  it("rejects a session with no durable entry with an actionable error", async () => {
    const sessionKey = "agent:main:fresh";
    freshSessionMocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: undefined,
    });

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
