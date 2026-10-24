import { expect, it, vi } from "vitest";
import {
  parseQuotaWaitArgs,
  waitForGithubApiQuota,
} from "../../scripts/wait-for-github-api-quota.mjs";

const epoch = 2_000_000_000_000;
const reset = epoch / 1_000 + 60;
function quotaResponse(remaining: number, requestId = "REQ-1", status = 200, resetAt = reset) {
  return Response.json(
    { resources: { core: { remaining, limit: 5_000, reset: resetAt } } },
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

it("waits below the dispatch reserve", async () => {
  let now = epoch;
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(quotaResponse(3, "LOW"))
    .mockResolvedValueOnce(quotaResponse(6, "READY"));
  const sleep = vi.fn(async (milliseconds: number) => {
    now += milliseconds;
  });
  await expect(wait({ fetchImpl, now: () => now, sleep, log: vi.fn() })).resolves.toMatchObject({
    remaining: 6,
    requestId: "READY",
  });

  expect(sleep).toHaveBeenCalledWith(65_000);
});

it.each([
  [
    "late reset",
    () => quotaResponse(0, "TOO-LATE", 200, epoch / 1_000 + 3_600),
    /request ID TOO-LATE; reset .* exceeds/u,
  ],
  ["permission error", () => quotaResponse(0, "REQ-1", 403), "HTTP 403; request ID REQ-1"],
] as const)("rejects %s without waiting", async (_label, response, message) => {
  await expect(wait({ fetchImpl: async () => response() })).rejects.toThrow(message);
});

it("parses a bounded request reserve", () => {
  expect(parseQuotaWaitArgs(["--minimum-remaining", "4", "--max-wait-seconds", "90"])).toEqual({
    minimumRemaining: 4,
    maxWaitMs: 90_000,
  });
  expect(() => parseQuotaWaitArgs(["--minimum-remaining", "0"])).toThrow();
});
