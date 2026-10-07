import { describe, expect, it } from "vitest";
import { resolveRemainingDoctorServiceInspectionTimeoutMs } from "./update-doctor-deadline.js";

describe("Doctor nested service-inspection budget", () => {
  it("limits each nested operation to the remaining parent budget", () => {
    const deadline = 15_000;
    expect(resolveRemainingDoctorServiceInspectionTimeoutMs(deadline, 10_000)).toBe(5_000);
    expect(resolveRemainingDoctorServiceInspectionTimeoutMs(deadline, 10_250)).toBe(4_750);
  });

  it("rejects an expired or invalid deadline before nested work can start", () => {
    expect(() => resolveRemainingDoctorServiceInspectionTimeoutMs(5_000, 5_000)).toThrow(
      "Doctor service-inspection deadline has expired.",
    );
    expect(() => resolveRemainingDoctorServiceInspectionTimeoutMs(Number.NaN, 1)).toThrow(
      "Doctor service-inspection deadline is invalid.",
    );
  });

  it("preserves unbounded direct Doctor behavior without a parent deadline", () => {
    expect(resolveRemainingDoctorServiceInspectionTimeoutMs(undefined, 123)).toBeUndefined();
  });
});
