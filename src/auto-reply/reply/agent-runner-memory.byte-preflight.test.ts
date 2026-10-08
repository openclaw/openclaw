import { expect, it, vi } from "vitest";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

const { compact, account } = vi.hoisted(() => ({ compact: vi.fn(), account: vi.fn() }));

// mock-isolation: Refusals must not start an embedded model or its runtime lifecycle.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
// mock-isolation: This preflight never dispatches a memory-flush model turn.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({}));
// mock-isolation: Supply admitted transcript pressure without starting database workers.
vi.mock("./agent-runner-memory-transcript-context.js", () => ({
  readSessionLogSnapshot: async () => ({ byteSize: 102_400 }),
}));
// mock-isolation: Failed compaction must not write session accounting or a success latch.
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: account }));

it.each([false, true])(
  "explains a declined Codex byte preflight without verbose details (ok=%s)",
  async (ok) => {
    compact.mockReset().mockResolvedValue({
      ok,
      compacted: false,
      reason: "fixture declines compaction: private diagnostic",
    });
    account.mockClear();
    const followupRun = createTestFollowupRun({ provider: "openai", model: "gpt-5.5" });
    const error = await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } } },
      followupRun,
      defaultModel: "gpt-5.5",
      sessionKey: "main",
      sessionEntry: { sessionId: "session", updatedAt: 1 },
      agentHarnessId: "codex",
      isHeartbeat: false,
    }).catch((failure: unknown) => failure);

    const reply = buildKnownAgentRunFailureReplyPayload({
      err: error,
      sessionCtx: { Provider: "webchat", ChatType: "direct" },
      resolvedVerboseLevel: "off",
    });
    expect(reply).toMatchObject({ isError: true });
    expect(reply?.text).toContain("Your message was not sent to Codex");
    expect(reply?.text).toContain("saved history exceeds its configured size limit");
    expect(reply?.text).toContain("/new, then resend your message");
    expect(reply?.text).not.toContain("private diagnostic");
    expect(compact).toHaveBeenCalledOnce();
    expect(account).not.toHaveBeenCalled();
  },
);
