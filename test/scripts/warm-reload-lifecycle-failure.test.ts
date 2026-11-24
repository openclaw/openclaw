import { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { finalizeManagedChild, hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { failManagedCleanup } from "../../scripts/lib/managed-cleanup-handoff.mts";
import { createWarmReloadGatewayOwner } from "../../scripts/perf/warm-reload-lifecycle.ts";

vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  finalizeManagedChild: vi.fn(),
}));
vi.mock("../../scripts/lib/managed-cleanup-handoff.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-cleanup-handoff.mts")>()),
  // No OS process is created. Keep injected uncertainty out of the runner's claim.
  claimManagedCleanup: async () => false,
  failManagedCleanup: vi.fn(),
}));

it("keeps uncertain Gateway cleanup visible and never reports its inputs releasable", async () => {
  const failure = Object.assign(new Error("process group inspection failed"), {
    processTreeState: "indeterminate",
  });
  vi.mocked(finalizeManagedChild).mockRejectedValue(failure);
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345 });
  const owner = await createWarmReloadGatewayOwner(new AbortController().signal);
  owner.start(() => child);
  const results = await Promise.allSettled([owner.close(), owner.close()]);
  expect(results).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  expect(hasUnjoinedWork(failure)).toBe(true);
  expect(owner.joined()).toBe(false);
  expect(finalizeManagedChild).toHaveBeenCalledOnce();
  expect(failManagedCleanup).toHaveBeenCalledOnce();
});
