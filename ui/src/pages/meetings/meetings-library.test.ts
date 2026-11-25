import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, mount } from "./meetings-page.test-support.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

it("does not reformat unchanged rows on refresh and still presents changed meeting fields", async () => {
  const date = vi.spyOn(Date.prototype, "toLocaleDateString");
  const time = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const sessions = Array.from({ length: 3 }, (_, index) => ({
    ...meetingEntry,
    selector: `meeting-${index}`,
    title: `Meeting ${index}`,
  }));
  const request = vi.fn(async () => ({ sessions: structuredClone(sessions), nextCursor: null }));
  const { page } = mount(request);
  await waitForSolid(() => expect(page.querySelectorAll(".meetings-row")).toHaveLength(3));
  const row = page.querySelector(".meetings-row");
  expect(date).toHaveBeenCalled();
  expect(time).toHaveBeenCalledTimes(3);
  date.mockClear();
  time.mockClear();

  button(page, "Refresh").click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.querySelector('[aria-busy="true"]')).toBeNull();
  });
  expect(page.querySelector(".meetings-row")).toBe(row);
  expect(date).not.toHaveBeenCalled();
  expect(time).not.toHaveBeenCalled();

  sessions[0] = {
    ...sessions[0]!,
    title: "Updated meeting",
    startedAt: "2026-08-28T10:00:00.000Z",
  };
  button(page, "Refresh").click();
  await waitForSolid(() => expect(page.textContent).toContain("Updated meeting"));
  expect(date).toHaveBeenCalled();
  expect(time).toHaveBeenCalledTimes(1);
  expect(page.querySelector(".meetings-row time")?.getAttribute("datetime")).toBe(
    "2026-08-28T10:00:00.000Z",
  );
});
