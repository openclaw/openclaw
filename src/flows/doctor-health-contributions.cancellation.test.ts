import { expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

it.each([false, true])(
  "stops admitting Doctor checks after cancellation (optional check throws: %s)",
  async (throws) => {
    const work = new AsyncWorkScope();
    const reason = new DOMException("CLI stopping (SIGTERM)", "AbortError");
    const later = vi.fn(async () => {});
    const cleaned = vi.fn();
    const ctx = createDoctorHealthFlowContext({ env: {} });
    await expect(
      work.track(() =>
        runDoctorHealthContributionList(ctx, [
          createDoctorHealthContribution("doctor:interrupted", "Interrupted inspection", {
            run: async () => {
              try {
                work.beginClose(reason);
                if (throws) {
                  throw new Error("Optional inspection failed during shutdown");
                }
              } finally {
                await Promise.resolve();
                cleaned();
              }
            },
          }),
          createDoctorHealthContribution("doctor:later", "Later inspection", later),
        ]),
      ),
    ).rejects.toBe(reason);
    await work.drain();
    expect(cleaned).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  },
);
