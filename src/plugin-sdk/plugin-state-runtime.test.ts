import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  configureSqliteConnectionPragmas,
  createPluginStateErrorReporter,
} from "./plugin-state-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const failure = () => {
  throw new Error("unavailable");
};
const runtime = (warn = vi.fn()) => ({ logging: { getChildLogger: () => ({ warn }) } }) as never;
const bindings = ["test-plugin", "state-cache", "persistent state failed"] as const;
const reporter = (
  getRuntime: Parameters<typeof createPluginStateErrorReporter>[0],
  formatError?: Parameters<typeof createPluginStateErrorReporter>[4],
) => createPluginStateErrorReporter(getRuntime, ...bindings, formatError);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("logs state failures with plugin bindings and default details", () => {
  const warn = vi.fn();
  const getChildLogger = vi.fn(() => ({ warn }));
  reporter(() => ({ logging: { getChildLogger } }) as never)(new Error("boom"));

  expect(getChildLogger).toHaveBeenCalledWith({
    plugin: "test-plugin",
    feature: "state-cache",
  });
  expect(warn).toHaveBeenCalledWith("persistent state failed", { error: "Error: boom" });
});

it("swallows failures from runtime lookup and error formatting", () => {
  expect(() => reporter(failure)(new Error("boom"))).not.toThrow();
  expect(() => reporter(runtime, failure)(new Error("boom"))).not.toThrow();
});
it("keeps the WAL retry budget stable across wall-clock jumps", () => {
  vi.useFakeTimers();
  const databasePath = path.join(tempDirs.make("openclaw-plugin-state-wal-"), "state.sqlite");
  const database = new DatabaseSync(databasePath);
  let journalModeAttempts = 0;
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql === "PRAGMA journal_mode = WAL;" && journalModeAttempts++ === 0) {
      vi.spyOn(statement, "get").mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + 1_000_000);
        throw Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
      });
    }
    return statement;
  });

  try {
    const maintenance = configureSqliteConnectionPragmas(database, {
      busyTimeoutMs: 50,
      checkpointIntervalMs: 0,
      databasePath,
    });

    expect(journalModeAttempts).toBe(2);
    expect(database.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
    expect(maintenance.close()).toBe(true);
  } finally {
    database.close();
  }
});
