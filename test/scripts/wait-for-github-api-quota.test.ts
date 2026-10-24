import { expect, it, vi } from "vitest";
import {
  parseQuotaWaitArgs,
  waitForGithubApiQuota,
} from "../../scripts/wait-for-github-api-quota.mjs";

const epoch = 2_000_000_000_000;
const reset = epoch / 1_000 + 60;
function quotaResponse(remaining: number, requestId = "REQ-1", status = 200, resetAt = reset) {
  return new Response(
    JSON.stringify({ resources: { core: { remaining, limit: 5_000, reset: resetAt } } }),
    {
      status,
      headers: { "x-github-request-id": requestId },
    },
  );
}
const wait = (options: Partial<Parameters<typeof waitForGithubApiQuota>[0]>) =>
  waitForGithubApiQuota({
    token: "fixture-token",
    now: () => epoch,
    maxWaitMs: 120_000,
    ...options,
  });

it("waits below the dispatch reserve and reports the reset identity", async () => {
  let now = epoch;
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(quotaResponse(3, "LOW"))
    .mockResolvedValueOnce(quotaResponse(6, "READY"));
  const sleep = vi.fn(async (milliseconds: number) => {
    now += milliseconds;
  });
  const log = vi.fn();

  await expect(
    wait({
      fetchImpl,
      now: () => now,
      sleep,
      log,
    }),
  ).resolves.toMatchObject({ remaining: 6, requestId: "READY" });

  expect(sleep).toHaveBeenCalledWith(65_000);
  expect(log.mock.calls.flat().join("\n")).toContain(
    "3/5000 remaining; request ID LOW; reset 2033-05-18T03:34:20Z",
  );
});

it("refuses a reset beyond the bounded acquisition wait", async () => {
  await expect(
    wait({
      fetchImpl: async () => quotaResponse(0, "TOO-LATE", 200, epoch / 1_000 + 3_600),
    }),
  ).rejects.toThrow(/request ID TOO-LATE; reset .* exceeds/u);
});

it("does not classify authentication or permission responses as quota waits", async () => {
  await expect(
    wait({
      fetchImpl: async () => quotaResponse(0, "REQ-1", 403),
    }),
  ).rejects.toThrow("HTTP 403; request ID REQ-1");
});

it("parses a bounded request reserve", () => {
  expect(parseQuotaWaitArgs(["--minimum-remaining", "4", "--max-wait-seconds", "90"])).toEqual({
    minimumRemaining: 4,
    maxWaitMs: 90_000,
  });
  expect(() => parseQuotaWaitArgs(["--minimum-remaining", "0"])).toThrow();
});
