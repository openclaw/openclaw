/** Shared status-summary cases for session runtime and context-window projection. */
import { expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";

type GetStatusSummary = typeof import("../status/summary.js").getStatusSummary;
type StatusSummaryRuntime = typeof import("../status/summary.runtime.js").statusSummaryRuntime;
type SessionStore = Record<string, Record<string, unknown>>;

export function registerStatusSummaryWalCases(getSummary: GetStatusSummary): void {
  it("preserves WAL facts without sensitive storage details", async () => {
    const error = "SYNTHETIC_PRIVATE_STORAGE_DETAIL";
    const sqliteWal = createSqliteWalHealth({ state: "error", error });
    using observation = vi.spyOn(stateDatabaseCache, "readOpenClawStateWalHealth");
    observation.mockReturnValueOnce(sqliteWal);
    const summary = await getSummary({ includeSensitive: false });
    expect(summary.sqliteWal).toEqual({ ...sqliteWal, error: undefined });
    expect(JSON.stringify(summary)).not.toContain(error);
  });
}

export function registerStatusSummarySessionRowCases(params: {
  getStatusSummary: () => ReturnType<GetStatusSummary>;
  getStatusSummaryRuntime: () => StatusSummaryRuntime;
  rejectProviderStaticModel: (error: Error) => void;
  setSessions: (store: SessionStore) => void;
}): void {
  async function sessionRow(entry: SessionStore[string]) {
    params.setSessions({ "agent:main:main": { updatedAt: Date.now(), ...entry } });
    return (await params.getStatusSummary()).sessions.recent[0];
  }

  it.each([
    { fastMode: true, fastFlag: "fast" },
    { fastMode: false, fastFlag: "fast:off" },
    { fastMode: "auto", fastFlag: "fast:auto" },
    { fastMode: "ultrafast", fastFlag: "fast:ultrafast" },
    { fastMode: undefined, fastFlag: undefined },
  ])("keeps session flag order with fast mode $fastMode", async ({ fastMode, fastFlag }) => {
    const row = await sessionRow({
      sessionId: "flag-order",
      thinkingLevel: "high",
      verboseLevel: "on",
      fastMode,
      reasoningLevel: "on",
      elevatedLevel: "full",
      systemSent: true,
      abortedLastRun: true,
    });
    expect(row?.flags).toEqual([
      "think:high",
      "verbose:on",
      ...(fastFlag === undefined ? [] : [fastFlag]),
      "reasoning:on",
      "elevated:full",
      "system",
      "aborted",
      "id:flag-order",
    ]);
  });

  it("keeps status available when static catalog lookup fails", async () => {
    const runtime = params.getStatusSummaryRuntime();
    vi.mocked(runtime.resolveConfiguredStatusModelRef).mockReturnValueOnce({
      provider: "broken-provider",
      model: "broken-model",
    });
    params.rejectProviderStaticModel(new Error("static catalog unavailable"));
    vi.mocked(runtime.resolveContextTokensForModel).mockReturnValue(undefined);

    const { sessions } = await params.getStatusSummary();
    expect(sessions.defaults).toMatchObject({ model: "broken-model", contextTokens: null });
  });

  it("rejects a stale runtime window after a same-model harness change", async () => {
    const runtime = params.getStatusSummaryRuntime();
    vi.mocked(runtime.resolveContextTokensForModel).mockReturnValue(1_000_000);
    vi.mocked(runtime.resolveSessionRuntime).mockReturnValue({
      id: "codex",
      label: "OpenAI Codex",
    });
    const row = await sessionRow({
      sessionId: "same-model-runtime-change",
      modelProvider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
      totalTokens: 11,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    expect(row).toMatchObject({
      runtime: "OpenAI Codex",
      contextTokens: 1_000_000,
      remainingTokens: 999_989,
    });
  });
}
