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
      totalTokens: 11,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    expect(row?.flags).toEqual([
      ..."think:high verbose:on".split(" "),
      ...(fastFlag === undefined ? [] : [fastFlag]),
      ..."reasoning:on elevated:full system aborted id:flag-order".split(" "),
    ]);
    expect(row?.remainingTokens).toBe(199_989);
  });

  it("keeps status available when static catalog lookup fails", async () => {
    const runtime = vi.mocked(params.getStatusSummaryRuntime());
    runtime.resolveConfiguredStatusModelRef.mockReturnValueOnce({ provider: "bad", model: "bad" });
    params.rejectProviderStaticModel(new Error("static catalog unavailable"));
    runtime.resolveContextTokensForModel.mockReturnValue(undefined);

    const { sessions } = await params.getStatusSummary();
    expect(sessions.defaults).toMatchObject({ model: "bad", contextTokens: null });
  });
}
