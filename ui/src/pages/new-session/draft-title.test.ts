import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createDraftTitleFixture } from "./draft-title.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

function fixture(pending = false) {
  const result = createDeferred<{ title: string }>();
  const prepare = vi.fn().mockResolvedValue({ title: "Repair sidebar naming" });
  if (pending) {
    prepare.mockImplementationOnce(() => result.promise);
  }
  const draft = createDraftTitleFixture(prepare);
  const edit = (message = "repair the sidebar naming") => {
    draft.flow.setMessage(message);
    draft.synchronizeTitles();
  };
  return { ...draft, prepare, edit, finish: result.resolve };
}

it.each(["edits", "composition"])("debounces %s without polling", async (change) => {
  const { edit, prepare, titles } = fixture();
  edit();
  await vi.advanceTimersByTimeAsync(900);
  if (change === "edits") {
    edit("repair sidebar naming and previews");
    await vi.advanceTimersByTimeAsync(900);
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    edit(" repair sidebar naming and previews ");
    await vi.advanceTimersByTimeAsync(30_000);
  } else {
    titles.setComposing(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).not.toHaveBeenCalled();
    titles.setComposing(false);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(prepare).toHaveBeenCalledOnce();
  expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
});

it.each(["edited", "disposed"])("discards a pending title when %s", async (change) => {
  const { edit, prepare, titles, disposeTitles, finish } = fixture(true);
  edit();
  await vi.advanceTimersByTimeAsync(1_000);
  if (change === "disposed") {
    disposeTitles();
  } else {
    edit("change the topic to reconnect recovery");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).toHaveBeenCalledOnce();
  }
  finish({ title: "Old draft" });
  await vi.advanceTimersByTimeAsync(change === "disposed" ? 5_000 : 0);
  expect(prepare).toHaveBeenCalledTimes(change === "disposed" ? 1 : 2);
  expect(titles.takePreparedTitle()).toBe(
    change === "disposed" ? undefined : "Repair sidebar naming",
  );
});

it("does not retry failures until the draft changes", async () => {
  const { edit, prepare, titles, synchronizeTitles } = fixture();
  prepare.mockRejectedValueOnce(new Error("provider unavailable"));
  edit();
  await vi.advanceTimersByTimeAsync(1_000);
  synchronizeTitles();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(prepare).toHaveBeenCalledOnce();
  expect(titles.takePreparedTitle()).toBeUndefined();
});
