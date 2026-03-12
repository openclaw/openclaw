import { describe, expect, it } from "vitest";
import { buildToolSidebarContent } from "./tool-cards.js";

describe("buildToolSidebarContent", () => {
  it("includes full command and output", () => {
    const command =
      "with python3 ~/.openclaw/workspace/skills/node-cluster-3.connector/scripts/main.py invoke wangjx-node-host system.run --raw-command='echo hello'";
    const content = buildToolSidebarContent({
      title: "Exec",
      detail: command,
      outputText: "line1\nline2",
    });

    expect(content).toContain("## Exec");
    expect(content).toContain("### Command");
    expect(content).toContain(command);
    expect(content).toContain("### Output");
    expect(content).toContain("line1\nline2");
  });

  it("shows completion text when output missing", () => {
    const content = buildToolSidebarContent({ title: "Exec", detail: "with ls -la" });
    expect(content).toContain("No output — tool completed successfully");
  });
});
