import { expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

const { compact, account } = vi.hoisted(() => ({ compact: vi.fn(), account: vi.fn() }));

// mock-isolation: Exercise preflight admission without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
// mock-isolation: This preflight never dispatches a memory-flush model turn.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({}));
// mock-isolation: Supply admitted transcript pressure without starting database workers.
vi.mock("./agent-runner-memory-transcript-context.js", () => ({
  readSessionLogSnapshot: async () => ({ byteSize: 102_400 }),
}));
// mock-isolation: Observe admission accounting without starting database workers.
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: account }));

it.each([
  { runtime: "codex", ok: false, compacted: false },
  { runtime: "codex", ok: true, compacted: false },
  { runtime: "codex", ok: true, compacted: false, reason: "already under target" },
  { runtime: "openclaw", ok: false, compacted: false },
  { runtime: "openclaw", ok: true, compacted: true },
])(
  "continues byte preflight with bounded context after $runtime compaction (ok=$ok, compacted=$compacted)",
  async ({ runtime, ok, compacted, reason = "fixture declines compaction" }) => {
    compact.mockReset().mockResolvedValue({ ok, compacted, reason });
    account
      .mockReset()
      .mockImplementation(
        async (
          params: Parameters<typeof import("./session-updates.js").incrementCompactionCount>[0],
        ) => {
          const entry = params.expectedSession;
          if (!entry || !params.sessionStore || !params.sessionKey) {
            throw new Error("Missing compaction accounting target");
          }
          const updated: InternalSessionEntry = {
            ...entry,
            updatedAt: 1,
            compactionCount: params.amount ?? 1,
            transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
          };
          params.sessionStore[params.sessionKey] = updated;
          return params.amount ?? 1;
        },
      );
    const followupRun = createTestFollowupRun({ provider: "openai", model: "gpt-5.5" });
    const notice = vi.fn();
    const params: Parameters<typeof runSessionCompactionIfNeeded>[0] = {
      cfg: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } } },
      followupRun,
      defaultModel: "gpt-5.5",
      sessionKey: "main",
      sessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      agentHarnessId: runtime,
      isHeartbeat: false,
      onCompactionNotice: notice,
    };
    const entry = await runSessionCompactionIfNeeded(params);

    expect(entry).toMatchObject({
      sessionId: "session",
      compactionCount: compacted ? 1 : 0,
      transcriptByteCompactionLatch: {
        activeBytes: 102_400,
        maxBytes: 32_768,
        sessionId: "session",
      },
    });
    expect(notice.mock.calls.map(([phase]) => phase)).toContain("context_bounded");
    notice.mockClear().mockRejectedValueOnce(new Error("fixture notice delivery failed"));
    await runSessionCompactionIfNeeded({
      ...params,
      sessionEntry: { ...params.sessionEntry!, ...entry },
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(notice.mock.calls.map(([phase]) => phase)).toContain("context_bounded");
  },
);
