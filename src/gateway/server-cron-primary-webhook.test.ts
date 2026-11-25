import { beforeEach, expect, it, vi } from "vitest";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import { createDeferredCore } from "../shared/deferred.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<(request: GuardedFetchOptions) => Promise<never>>(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

import { sendGatewayCronWebhook } from "./server-cron-notifications.js";

function sendWebhook(overrides: Partial<Parameters<typeof sendGatewayCronWebhook>[0]> = {}) {
  const job = makeCronJob({
    delivery: { mode: "webhook", to: "https://example.invalid/cron" },
  });
  return sendGatewayCronWebhook({
    event: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
    job,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("propagates cancellation and the remaining run deadline without retrying", async () => {
  const controller = new AbortController();
  const ssrfPolicy = { allowedHostnames: ["127.0.0.1"] };
  const started = createDeferredCore();
  mocks.fetchWithSsrFGuard.mockImplementationOnce(async (request: GuardedFetchOptions) => {
    request.beforeRequest?.();
    started.resolve();
    const signal = request.signal;
    if (!signal) {
      throw new Error("expected run abort signal");
    }
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error(String(signal.reason ?? "aborted"))),
        { once: true },
      );
    });
  });
  const deadlineAtMs = Date.now() + 5_000;
  const delivery = sendWebhook({
    abortSignal: controller.signal,
    deadlineAtMs,
    ssrfPolicy,
  });

  await started.promise;
  const request = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0];
  expect(request?.signal).toBe(controller.signal);
  expect(request?.timeoutMs).toEqual(expect.any(Number));
  expect(request?.timeoutMs).toBeGreaterThan(0);
  expect(request?.timeoutMs).toBeLessThanOrEqual(5_000);
  expect(request?.policy).toBe(ssrfPolicy);

  controller.abort("Cancelled by operator.");
  await expect(delivery).resolves.toMatchObject({
    status: "unknown",
    error: "Cancelled by operator.",
  });
  expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
});
it.each([
  { redirected: false, status: "not-delivered" },
  { redirected: true, status: "unknown" },
] as const)(
  "keeps DNS failure evidence after redirect=$redirected",
  async ({ redirected, status }) => {
    const controller = new AbortController();
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async (request: GuardedFetchOptions) => {
      request.beforeRequest?.();
      if (redirected) {
        request.onResponse?.(302);
      } else {
        controller.abort();
      }
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
      });
    });
    await expect(
      sendWebhook({
        abortSignal: controller.signal,
      }),
    ).resolves.toEqual({ status, error: "getaddrinfo ENOTFOUND" });
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  },
);
