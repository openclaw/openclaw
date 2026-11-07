import { afterEach, expect, it, vi } from "vitest";
import { waitForSettledCodexCatalog } from "./gateway-codex-harness.catalog.live-helpers.js";

afterEach(() => vi.useRealTimers());

it("waits only for explicit pending and keeps one shared request budget", async () => {
  vi.useFakeTimers();
  const ready = { catalogs: [{ hosts: [{ sessions: [{ threadId: "native" }] }] }] };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ catalogs: [{ error: { code: "catalog_pending" } }] })
    .mockResolvedValue(ready);
  const result = waitForSettledCodexCatalog(read, 1000);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toBe(ready);
  expect(read.mock.calls.map(([budget]) => budget)).toEqual([1000, 750]);
});

it.each([
  { catalogs: [] },
  { catalogs: [{ error: { code: "catalog_stale" } }] },
  { catalogs: [{ hosts: [] }] },
])("returns settled empty or error catalogs without retrying: %j", async ({ catalogs }) => {
  const result = { catalogs };
  const read = vi.fn().mockResolvedValue(result);
  expect(await waitForSettledCodexCatalog(read, 1000)).toBe(result);
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not retry transport failures", async () => {
  const error = new Error("transport failed");
  const read = vi.fn().mockRejectedValue(error);
  await expect(waitForSettledCodexCatalog(read, 1000)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});

it("fails at the shared deadline if discovery never settles", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ catalogs: [{ error: { code: "catalog_pending" } }] });
  const result = expect(waitForSettledCodexCatalog(read, 500)).rejects.toThrow(
    "remained catalog_pending",
  );
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(read).toHaveBeenCalledTimes(2);
});
