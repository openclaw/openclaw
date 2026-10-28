import { expect, it, vi } from "vitest";
import {
  isSqliteWorkerCloseContention,
  settleSqliteWorkerCloseWithContentionRetry,
  SQLITE_WORKER_CLOSE_RETRY_DELAYS_MS,
} from "./session-accessor.sqlite-worker-close-contention.js";

/** The production shape: the write path reports contention in the message. */
const contention = () => new Error("database is locked");

it("retries a close that lost its race and keeps the settled result", async () => {
  const settle = vi
    .fn()
    .mockResolvedValueOnce({ errors: [contention()], settled: false })
    .mockResolvedValueOnce({ errors: [], settled: true });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const outcome = await settleSqliteWorkerCloseWithContentionRetry({ settle, sleep });
  expect(outcome.result.settled).toBe(true);
  expect(outcome.result.errors).toEqual([]);
  expect(outcome.attempts).toBe(2);
  expect(outcome.contended).toBe(true);
  expect(sleep).toHaveBeenCalledTimes(1);
});

it("does not retry a close that already settled", async () => {
  const settle = vi.fn().mockResolvedValue({ errors: [], settled: true });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const outcome = await settleSqliteWorkerCloseWithContentionRetry({ settle, sleep });
  expect(outcome.attempts).toBe(1);
  expect(outcome.contended).toBe(false);
  expect(sleep).not.toHaveBeenCalled();
});

it("keeps a damaged database terminal instead of retrying it", async () => {
  const settle = vi.fn().mockResolvedValue({
    errors: [new Error("file is not a database")],
    settled: false,
  });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const outcome = await settleSqliteWorkerCloseWithContentionRetry({ settle, sleep });
  expect(outcome.result.settled).toBe(false);
  expect(outcome.result.errors[0]?.message).toBe("file is not a database");
  expect(outcome.attempts).toBe(1);
  expect(outcome.contended).toBe(false);
  expect(sleep).not.toHaveBeenCalled();
});

it("keeps a mixed close failure out of the retry path", async () => {
  const mixed = new AggregateError([contention(), new Error("disk I/O error")], "close failed");
  const settle = vi.fn().mockResolvedValue({ errors: [mixed], settled: false });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const outcome = await settleSqliteWorkerCloseWithContentionRetry({ settle, sleep });
  expect(outcome.attempts).toBe(1);
  expect(outcome.contended).toBe(false);
  expect(sleep).not.toHaveBeenCalled();
  expect(isSqliteWorkerCloseContention({ errors: [mixed], settled: false })).toBe(false);
});

it("stops at the bounded budget when the close keeps losing its race", async () => {
  const settle = vi.fn().mockResolvedValue({ errors: [contention()], settled: false });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const outcome = await settleSqliteWorkerCloseWithContentionRetry({ settle, sleep });
  expect(outcome.attempts).toBe(SQLITE_WORKER_CLOSE_RETRY_DELAYS_MS.length + 1);
  expect(outcome.contended).toBe(true);
  expect(outcome.result.settled).toBe(false);
  expect(sleep).toHaveBeenCalledTimes(SQLITE_WORKER_CLOSE_RETRY_DELAYS_MS.length);
});

it("classifies a contended close and leaves a settled close alone", () => {
  expect(isSqliteWorkerCloseContention({ errors: [contention()], settled: false })).toBe(true);
  expect(isSqliteWorkerCloseContention({ errors: [], settled: false })).toBe(false);
  expect(isSqliteWorkerCloseContention({ errors: [], settled: true })).toBe(false);
});
