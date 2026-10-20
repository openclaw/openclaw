import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createDraftTitleFixture } from "./draft-title.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

function fixture() {
  const prepare = vi.fn().mockResolvedValue({ title: "Repair sidebar naming" });
  const draft = createDraftTitleFixture(prepare);
  const edit = (message = "repair the sidebar naming") => {
    draft.flow.setMessage(message);
    draft.synchronizeTitles();
  };
  return { ...draft, prepare, edit };
}

async function pendingTitle() {
  const draft = fixture();
  const pending = createDeferred<{ title: string }>();
  draft.prepare.mockImplementationOnce(() => pending.promise);
  draft.edit();
  await vi.advanceTimersByTimeAsync(1_000);
  return { ...draft, finish: pending.resolve };
}

describe("creation draft title preparation", () => {
  it("coalesces idle edits and reuses unchanged text without polling", async () => {
    const { edit, prepare, titles } = fixture();
    edit();
    await vi.advanceTimersByTimeAsync(900);
    edit("repair sidebar naming and previews");
    await vi.advanceTimersByTimeAsync(900);
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    edit(" repair sidebar naming and previews ");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).toHaveBeenCalledOnce();
    expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
  });

  it("serializes edits behind an active request and discards the stale result", async () => {
    const { edit, prepare, titles, finish } = await pendingTitle();
    edit("change the topic to reconnect recovery");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).toHaveBeenCalledOnce();
    finish({ title: "Old draft" });
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
  });

  it("retires pending results when the draft owner closes", async () => {
    const { prepare, titles, disposeTitles, finish } = await pendingTitle();
    disposeTitles();
    finish({ title: "Must not apply" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles.takePreparedTitle()).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("synchronously pauses and restarts preparation around composition", async () => {
    const { edit, prepare, titles } = fixture();
    edit();
    await vi.advanceTimersByTimeAsync(900);
    titles.setComposing(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).not.toHaveBeenCalled();
    titles.setComposing(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prepare).toHaveBeenCalledOnce();
    expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
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
});
