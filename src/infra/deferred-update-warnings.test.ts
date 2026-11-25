import { expect, it, vi } from "vitest";
import { retainCurrentDeferredUpdateWarnings } from "./deferred-update-warnings.js";
import { DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING } from "./update-deferred-model-retirement.js";

it.each(["completed", "skipped", "failed", undefined] as const)(
  "requires positive retirement completion (%s)",
  async (status) => {
    const warnings = [DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING, "Unrelated advisory"];
    const readUpdateRun = vi.fn(() => ({
      steps: status ? [{ step: "finalize:doctor:model-retirement", status }] : [],
    }));

    expect(await retainCurrentDeferredUpdateWarnings(warnings, { readUpdateRun })).toEqual(
      status === "completed" ? warnings.slice(1) : warnings,
    );
    expect(readUpdateRun).toHaveBeenCalledOnce();
  },
);

it("reads the selected run only when needed and preserves warnings on read failure", async () => {
  const readUpdateRun = vi.fn(() => {
    throw new Error("Selected update ledger unavailable");
  });
  const unrelated = ["Unrelated advisory"];
  expect(await retainCurrentDeferredUpdateWarnings(unrelated, { readUpdateRun })).toEqual(
    unrelated,
  );
  expect(readUpdateRun).not.toHaveBeenCalled();

  const warnings = [DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING, ...unrelated];
  expect(await retainCurrentDeferredUpdateWarnings(warnings, { readUpdateRun })).toEqual(warnings);
  expect(readUpdateRun).toHaveBeenCalledOnce();
  expect(await retainCurrentDeferredUpdateWarnings(warnings)).toEqual(warnings);
});
