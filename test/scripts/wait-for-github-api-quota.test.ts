import { describe, expect, it, vi } from "vitest";
import {
  parseQuotaWaitArgs,
  waitForGithubApiQuota,
} from "../../scripts/wait-for-github-api-quota.mjs";

type QuotaResponseOptions = {
  remaining: number;
  reset: number;
  requestId?: string;
  status?: number;
};

function quotaResponse({
  remaining,
  reset,
  requestId = "REQ-1",
  status = 200,
}: QuotaResponseOptions) {
  return new Response(JSON.stringify({ resources: { core: { remaining, limit: 5_000, reset } } }), {
    status,
    headers: { "x-github-request-id": requestId },
  });
}

describe("candidate acquisition GitHub API quota wait", () => {
  it("waits for an exhausted installation quota and reports its reset identity", async () => {
    let epoch = 2_000_000_000_000;
    const reset = epoch / 1_000 + 60;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(quotaResponse({ remaining: 0, reset, requestId: "EXHAUSTED" }))
      .mockResolvedValueOnce(quotaResponse({ remaining: 5_000, reset, requestId: "READY" }));
    const sleep = vi.fn(async (milliseconds: number) => {
      epoch += milliseconds;
    });
    const log = vi.fn();

    await expect(
      waitForGithubApiQuota({
        token: "fixture-token",
        fetchImpl,
        now: () => epoch,
        sleep,
        log,
        maxWaitMs: 120_000,
      }),
    ).resolves.toMatchObject({ remaining: 5_000, requestId: "READY" });

    expect(sleep).toHaveBeenCalledWith(65_000);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "0/5000 remaining; request ID EXHAUSTED; reset 2033-05-18T03:34:20Z",
    );
  });

  it("waits when a positive quota cannot cover dispatch setup and identity reads", async () => {
    let epoch = 2_000_000_000_000;
    const reset = epoch / 1_000 + 60;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(quotaResponse({ remaining: 3, reset }))
      .mockResolvedValueOnce(quotaResponse({ remaining: 6, reset }));
    const sleep = vi.fn(async (milliseconds: number) => {
      epoch += milliseconds;
    });

    await expect(
      waitForGithubApiQuota({
        token: "fixture-token",
        fetchImpl,
        now: () => epoch,
        sleep,
        log: vi.fn(),
        maxWaitMs: 120_000,
      }),
    ).resolves.toMatchObject({ remaining: 6 });
    expect(sleep).toHaveBeenCalledWith(65_000);
  });

  it("refuses a reset beyond the bounded acquisition wait", async () => {
    const epoch = 2_000_000_000_000;
    await expect(
      waitForGithubApiQuota({
        token: "fixture-token",
        fetchImpl: async () =>
          quotaResponse({ remaining: 0, reset: epoch / 1_000 + 3_600, requestId: "TOO-LATE" }),
        now: () => epoch,
        maxWaitMs: 60_000,
      }),
    ).rejects.toThrow(/request ID TOO-LATE; reset .* exceeds/u);
  });

  it("does not classify authentication or permission responses as quota waits", async () => {
    await expect(
      waitForGithubApiQuota({
        token: "fixture-token",
        fetchImpl: async () => quotaResponse({ remaining: 0, reset: 1, status: 403 }),
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
});
