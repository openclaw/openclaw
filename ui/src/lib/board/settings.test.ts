import { describe, expect, it } from "vitest";
import {
  normalizeBoardSessionViews,
  type BoardSessionViews,
  updateBoardSessionView,
} from "./settings.ts";

describe("board session view settings", () => {
  it("retains dashboard tab choices for the 500 most recently changed sessions", () => {
    let views: BoardSessionViews = {};
    for (let index = 0; index < 505; index += 1) {
      views = updateBoardSessionView(views, `session-${index}`, { activeTabId: `tab-${index}` });
    }
    const storedViews = JSON.stringify(views);
    views = normalizeBoardSessionViews(JSON.parse(storedViews));
    expect(Object.keys(views)).toHaveLength(500);
    expect(views["session-4"]).toBeUndefined();
    expect(views["session-5"]?.activeTabId).toBe("tab-5");
    expect(views["session-504"]?.activeTabId).toBe("tab-504");

    views = updateBoardSessionView(views, "session-5", { activeTabId: "updated-tab" });
    views = updateBoardSessionView(views, "session-505", { activeTabId: "tab-505" });
    expect(Object.keys(views)).toHaveLength(500);
    expect(views["session-5"]?.activeTabId).toBe("updated-tab");
    expect(views["session-6"]).toBeUndefined();
  });
});
