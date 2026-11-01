import { afterEach, expect, it, vi } from "vitest";
import * as toast from "../../lib/toast.ts";
import type { NewSessionDraft } from "./draft.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";
import { PaletteDraftSlot, PaletteReleasedStarts } from "./palette-session-starts.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function slot(error: string | null = "Gateway refused the session") {
  const submission = {
    submitting: true,
    error,
    submissionOutcomeUnknown: null,
    submitDisabledReason: () => undefined,
    submit: vi.fn(async () => {}),
  };
  const draft = { submission, synchronize: vi.fn(), disconnect: vi.fn() };
  // A minimal draft double: the owner reads only submission state and lifecycle.
  return {
    slot: new PaletteDraftSlot(
      createNewSessionRouteData(),
      () => draft as unknown as NewSessionDraft,
    ),
    submission,
    draft,
  };
}

function settle(starts: PaletteReleasedStarts, entry: ReturnType<typeof slot>) {
  entry.submission.submitting = false;
  starts.observe(entry.slot);
}

it("reports each failed start once, retries it, and bounds retained failures", async () => {
  const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const starts = new PaletteReleasedStarts(() => "owner");
  const entries = Array.from({ length: 9 }, () => slot());
  for (const entry of entries) {
    starts.adopt(entry.slot);
    settle(starts, entry);
    starts.observe(entry.slot);
  }
  expect(showToast).toHaveBeenCalledTimes(9);
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: "Session didn't start: Gateway refused the session",
      actionLabel: "Try again",
    }),
  );
  await Promise.resolve();
  // Only the oldest failure is released once the bound is exceeded.
  expect(entries.map((entry) => entry.draft.disconnect.mock.calls.length)).toEqual([
    1, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  starts.retry(entries[0]!.slot);
  expect(entries[0]!.submission.submit).not.toHaveBeenCalled();
  showToast.mock.calls.at(-1)?.[0].onAction?.();
  expect(entries[8]!.submission.submit).toHaveBeenCalledExactlyOnceWith(undefined, true);
});

it("settles accepted and aborted starts without a notice", async () => {
  const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const starts = new PaletteReleasedStarts(() => "owner");
  const accepted = slot("Initial turn rejected");
  const aborted = slot(null);
  accepted.slot.accepted = true;
  for (const entry of [accepted, aborted]) {
    starts.adopt(entry.slot);
    settle(starts, entry);
  }
  await Promise.resolve();
  expect(showToast).not.toHaveBeenCalled();
  expect(accepted.draft.disconnect).toHaveBeenCalledOnce();
  expect(aborted.draft.disconnect).toHaveBeenCalledOnce();
});

it("never reports or retries a start for a replaced owner", async () => {
  const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
  let owner = "first";
  const starts = new PaletteReleasedStarts(() => owner);
  const entry = slot();
  starts.adopt(entry.slot);
  owner = "second";
  settle(starts, entry);
  await Promise.resolve();
  expect(showToast).not.toHaveBeenCalled();
  expect(entry.draft.disconnect).toHaveBeenCalledOnce();
  starts.retry(entry.slot);
  expect(entry.submission.submit).not.toHaveBeenCalled();
});
