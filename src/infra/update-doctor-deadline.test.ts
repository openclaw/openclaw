import { afterEach, expect, it, vi } from "vitest";
import { createDoctorServiceInspectionBudget } from "./update-doctor-deadline.js";

afterEach(() => vi.restoreAllMocks());

it("leaves unspecified budgets unbounded", () => {
  expect(createDoctorServiceInspectionBudget(undefined)()).toBeUndefined();
});

it.each([-10_000, 10_000])(
  "does not replenish a budget after a wall-clock correction of %s",
  (correction) => {
    let elapsed = 20;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const remaining = createDoctorServiceInspectionBudget(1_100);
    expect(remaining()).toBe(100);
    wall.mockReturnValue(1_000 + correction);
    elapsed = 119.5;
    expect(remaining()).toBe(1);
    elapsed = 120;
    expect(() => remaining()).toThrow("deadline has expired");
  },
);

it("rejects an already-expired handoff before inspection", () => {
  vi.spyOn(performance, "now").mockReturnValue(20);
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  expect(() => createDoctorServiceInspectionBudget(1_000)()).toThrow("deadline has expired");
});
