import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { formatUpdateFinalizationError } from "./update-command-result.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("retains the real SQLite contention site through a frozen cyclic aggregate without changing the error", () => {
  const file = path.join(dirs.make("update-finalization-error-"), "state.sqlite");
  const writer = openNodeSqliteDatabase(file);
  const contender = openNodeSqliteDatabase(file);
  try {
    writer.exec("CREATE TABLE records (value TEXT); BEGIN IMMEDIATE;");
    contender.exec("PRAGMA busy_timeout=0;");
    let failure: unknown;
    function contendAtRestoreBoundary() {
      contender.exec("BEGIN IMMEDIATE;");
    }
    try {
      contendAtRestoreBoundary();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(isSqliteLockError(failure)).toBe(true);
    const wrapper = new AggregateError([new Error("candidate failed"), failure], "restore pending");
    wrapper.cause = wrapper;
    Object.freeze(wrapper);
    const before = Object.getOwnPropertyDescriptors(wrapper);
    const ordinary = formatErrorMessage(wrapper);
    const display = formatUpdateFinalizationError(wrapper);
    expect(display).toContain(ordinary);
    expect(display).toContain("contendAtRestoreBoundary");
    expect(display.length).toBeLessThanOrEqual(ordinary.length + 2_049);
    expect(formatErrorMessage(wrapper)).toBe(ordinary);
    expect(Object.getOwnPropertyDescriptors(wrapper)).toEqual(before);
    expect(isSqliteLockError(failure)).toBe(true);
    expect(writer.isTransaction).toBe(true);
  } finally {
    contender.close();
    writer.close();
  }
});

it("bounds and redacts causal stacks while leaving non-contention reporting unchanged", () => {
  const lock = Object.assign(new Error("database is locked"), { errcode: 5 });
  const secret = "fixture-private-credential-abcdefghijklmnopqrstuvwxyz";
  lock.stack = `Error: database is locked\nAuthorization: Bearer ${secret}\n${"x".repeat(4_000)}`;
  const outer = Object.freeze(new Error("restoration pending", { cause: lock }));
  const message = formatErrorMessage(outer);
  const display = formatUpdateFinalizationError(outer);
  expect(display).toContain("Authorization: Bearer ***");
  expect(display).not.toContain(secret);
  expect(display.length).toBeLessThanOrEqual(message.length + 2_049);
  const unrelated = new Error("native owner changed");
  expect(formatUpdateFinalizationError(unrelated)).toBe(formatErrorMessage(unrelated));
  expect(formatUpdateFinalizationError(null)).toBe(formatErrorMessage(null));
});
