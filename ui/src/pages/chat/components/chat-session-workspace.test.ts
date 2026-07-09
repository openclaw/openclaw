import { describe, expect, it } from "vitest";
import { workspaceBrowserFilePath } from "./chat-session-workspace.ts";

describe("workspaceBrowserFilePath", () => {
  it("resolves browser rows from the workspace root", () => {
    expect(workspaceBrowserFilePath("/workspace", "src/readme.md")).toBe(
      "/workspace/src/readme.md",
    );
  });

  it("preserves Windows workspace separators", () => {
    expect(workspaceBrowserFilePath("C:\\workspace", "src/readme.md")).toBe(
      "C:\\workspace\\src\\readme.md",
    );
  });

  it("preserves the POSIX filesystem root", () => {
    expect(workspaceBrowserFilePath("/", "src/readme.md")).toBe("/src/readme.md");
  });
});
