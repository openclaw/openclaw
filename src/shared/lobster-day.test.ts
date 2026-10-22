import { describe, expect, it } from "vitest";
import { isLobsterDay } from "./lobster-day.js";

describe("isLobsterDay", () => {
  it("stays rare across a year of days", () => {
    let hits = 0;
    for (let offset = 0; offset < 400; offset++) {
      if (isLobsterDay(new Date(2026, 0, 1 + offset))) {
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(60);
  });
});
