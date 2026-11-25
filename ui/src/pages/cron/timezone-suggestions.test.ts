import { describe, expect, it } from "vitest";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";

describe("resolveTimezoneSuggestions", () => {
  it("prioritizes relevant zones before the browser catalog", () => {
    expect(
      resolveTimezoneSuggestions(
        ["Pacific/Chatham", "UTC", " Pacific/Chatham "],
        "Asia/Singapore",
        ["Europe/London", "America/New_York", "Asia/Singapore"],
      ),
    ).toEqual(["Asia/Singapore", "UTC", "Pacific/Chatham", "America/New_York", "Europe/London"]);
  });

  it("keeps useful suggestions when the browser catalog is unavailable", () => {
    expect(resolveTimezoneSuggestions(["America/St_Johns"], "", [])).toEqual([
      "UTC",
      "America/St_Johns",
    ]);
  });
});
