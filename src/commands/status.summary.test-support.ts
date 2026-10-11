/** Shared status-summary cases for session runtime and context-window projection. */
import { describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";

type GetStatusSummary = typeof import("../status/summary.js").getStatusSummary;
type StatusSummaryRuntime = typeof import("../status/summary.runtime.js").statusSummaryRuntime;
type SessionStore = Record<string, Record<string, unknown>>;

export function registerStatusSummaryWalCases(getSummary: GetStatusSummary): void {
  it.each([false])("preserves WAL facts with includeSensitive=%s", async (includeSensitive) => {
    const error = "SYNTHETIC_PRIVATE_STORAGE_DETAIL";
    const sqliteWal = createSqliteWalHealth({
      state: "error",
      walBytes: 1024,
      databaseBytes: 4096,
      logFrames: null,
      checkpointedFrames: null,
      consecutiveBlocked: 0,
      error,
    });
    const observation = vi
      .spyOn(stateDatabaseCache, "readOpenClawStateWalHealth")
      .mockReturnValueOnce(sqliteWal);
    try {
      const summary = await getSummary({ includeSensitive });
      expect(summary.sqliteWal).toEqual({
        ...sqliteWal,
        error: includeSensitive ? error : undefined,
      });
      expect(JSON.stringify(summary).includes(error)).toBe(includeSensitive);
    } finally {
      observation.mockRestore();
    }
  });
}

export function registerStatusSummarySessionRowCases(params: {
  getStatusSummary: () => ReturnType<GetStatusSummary>;
  getStatusSummaryRuntime: () => StatusSummaryRuntime;
  rejectProviderStaticModel: (error: Error) => void;
  setSessions: (store: SessionStore) => void;
}): void {
  describe("status summary session rows", () => {
    it("keeps status available when static catalog lookup fails", async () => {
      vi.mocked(
        params.getStatusSummaryRuntime().resolveConfiguredStatusModelRef,
      ).mockReturnValueOnce({
        provider: "broken-provider",
        model: "broken-model",
      });
      params.rejectProviderStaticModel(new Error("static catalog unavailable"));

      await expect(params.getStatusSummary()).resolves.toMatchObject({
        sessions: {
          defaults: {
            model: "broken-model",
            contextTokens: 200_000,
          },
        },
      });
    });

    it("retains the legacy host API fallback when offline metadata is unavailable", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveConfiguredStatusModelRef).mockReturnValue({
        provider: "fixture",
        model: "unreported",
      });
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionModelRef).mockReturnValue({
        provider: "fixture",
        model: "unreported",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "offline-api",
          updatedAt: 1,
          modelProvider: "fixture",
          model: "unreported",
          totalTokens: 45_000,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });
      const summary = await params.getStatusSummary();
      expect(summary.sessions.recent[0]).toMatchObject({
        contextTokens: 200_000,
        remainingTokens: 155_000,
        percentUsed: 23,
      });
    });

    it("rejects a stale runtime window after a same-model harness change", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "same-model-runtime-change",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]).toMatchObject({
        runtime: "OpenAI Codex",
        contextTokens: null,
        remainingTokens: null,
      });
    });
  });
}
