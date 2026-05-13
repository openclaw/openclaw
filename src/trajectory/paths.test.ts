import { describe, expect, it } from "vitest";
import { safeTrajectorySessionFileName } from "./paths.js";

describe("trajectory path helpers", () => {
  it("sanitizes session ids for export directory names", () => {
    expect(safeTrajectorySessionFileName("../evil/session")).toBe("___evil_session");
    expect(safeTrajectorySessionFileName("")).toBe("session");
  });
});
