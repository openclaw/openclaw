import { describe, expect, it } from "vitest";
import { handleSubagentsHelpAction } from "./action-help.js";

describe("handleSubagentsHelpAction", () => {
  it("renders subagents usage help", () => {
    const result = handleSubagentsHelpAction();

    expect(result.reply?.text).toContain("Subagents");
    expect(result.reply?.text).toContain("/subagents list");
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });
});
