import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { projectCompactionAccountingPatch } from "../../config/sessions/session-entry-projection.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
} from "../../config/sessions/types.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const { compact, account } = vi.hoisted(() => ({ compact: vi.fn(), account: vi.fn() }));

// mock-isolation: Exercise preflight admission without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
// mock-isolation: This preflight never dispatches a memory-flush model turn.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({}));
// mock-isolation: Keep byte-pressure admission independent of token estimates and database workers.
vi.mock("./agent-runner-memory-transcript-context.js", () => ({
  estimateContextTokensFromSessionTranscript: async () => undefined,
  readSessionLogSnapshot: async () => ({}),
}));
// mock-isolation: Supply raw accounting at the transcript reader boundary.
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionTranscriptAccountingAsync: async () => ({ byteSize: 102_400 }),
}));
// mock-isolation: Observe admission accounting without starting database workers.
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: account }));

it.each([
  { runtime: "openclaw", ok: false, compacted: false },
  { runtime: "openclaw", ok: true, compacted: true },
])(
  "continues built-in byte preflight with bounded context (ok=$ok, compacted=$compacted)",
  async ({ runtime, ok, compacted }) => {
    compact.mockReset().mockResolvedValue({ ok, compacted, reason: "fixture declines compaction" });
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
          const current: InternalSessionEntry = { ...entry, updatedAt: 1 };
          const updated: InternalSessionEntry = {
            ...current,
            ...projectCompactionAccountingPatch(current, params),
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
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      agentHarnessId: runtime,

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

it("compacts at the history byte cap without a configured limit, announcing nothing per bounded turn", async () => {
  compact
    .mockReset()
    .mockResolvedValue({ ok: false, compacted: false, reason: "fixture declines" });
  account
    .mockReset()
    .mockImplementation(
      async (
        params: Parameters<typeof import("./session-updates.js").incrementCompactionCount>[0],
      ) => {
        const entry = params.expectedSession!;
        const updated: InternalSessionEntry = {
          ...entry,
          ...projectCompactionAccountingPatch({ ...entry, updatedAt: 1 }, params),
        };
        params.sessionStore![params.sessionKey!] = updated;
        return params.amount ?? 1;
      },
    );
  const followupRun = createTestFollowupRun({ provider: "openai", model: "gpt-5.5" });
  const notice = vi.fn();
  // The hydration cap is 8 bytes per context token: 12,800 tokens -> 102,400 bytes, the fixture size.
  const cfg = withTestModelContextTokens({
    cfg: {},
    followupRun,
    defaultModel: "gpt-5.5",
    contextTokens: 12_800,
  });
  setRuntimeConfigSnapshot(cfg);
  const params: Parameters<typeof runSessionCompactionIfNeeded>[0] = {
    cfg,
    followupRun,
    defaultModel: "gpt-5.5",
    sessionKey: "main",
    sessionEntry: {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    },
    agentHarnessId: "openclaw",
    onCompactionNotice: notice,
  };
  const entry = await runSessionCompactionIfNeeded(params);
  expect(compact).toHaveBeenCalledOnce();
  expect(entry).toMatchObject({
    transcriptByteCompactionLatch: { activeBytes: 102_400, maxBytes: 102_400 },
  });
  // A failed attempt reports once; the latched turns that follow stay silent.
  notice.mockClear();
  await runSessionCompactionIfNeeded({
    ...params,
    sessionEntry: { ...params.sessionEntry!, ...entry },
  });
  expect(compact).toHaveBeenCalledOnce();
  expect(notice).not.toHaveBeenCalled();
});
