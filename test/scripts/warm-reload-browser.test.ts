import type { chromium } from "playwright";
import { beforeEach, expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { failManagedCleanup } from "../../scripts/lib/managed-cleanup-handoff.mts";
import { launchWarmReloadBrowser } from "../../scripts/perf/warm-reload-browser.ts";

const launch = vi.hoisted(() => vi.fn<typeof chromium.launch>());

vi.mock("playwright", async (importOriginal) => ({
  ...(await importOriginal<typeof import("playwright")>()),
  chromium: { launch },
}));
vi.mock("../../scripts/lib/managed-cleanup-handoff.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-cleanup-handoff.mts")>()),
  // Injected browser failures have no live process; isolate the runner's claim.
  failManagedCleanup: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

it.each(["joined", "unjoined"] as const)(
  "reports browser startup failure with %s cleanup to its caller",
  async (cleanup) => {
    const launchFailure = new Error("browser command-line inspection failed");
    const closeFailure = new Error("browser connection lost during close");
    const close = vi.fn(async () => {
      if (cleanup === "unjoined") {
        throw closeFailure;
      }
    });
    launch.mockResolvedValue({
      close,
      newBrowserCDPSession: async () => {
        throw launchFailure;
      },
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
    const error = await launchWarmReloadBrowser().catch((cause: unknown) => cause);
    expect(hasUnjoinedWork(error)).toBe(cleanup === "unjoined");
    if (cleanup === "unjoined") {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([launchFailure, closeFailure]);
    } else {
      expect(error).toBe(launchFailure);
    }
    expect(close).toHaveBeenCalledOnce();
    expect(failManagedCleanup).toHaveBeenCalledTimes(cleanup === "unjoined" ? 1 : 0);
  },
);
