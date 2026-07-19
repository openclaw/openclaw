import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillPath =
  process.env.TEST_CODING_AGENT_SKILL_PATH ??
  path.resolve(import.meta.dirname, "..", "..", "..", "skills", "coding-agent", "SKILL.md");

describe("coding-agent completion notification", () => {
  it("keeps delivery in the authenticated parent runtime", () => {
    const skill = fs.readFileSync(skillPath, "utf8");

    expect(skill).toContain(
      "Parent must send exactly one completion/failure notification with the `message` tool",
    );
    expect(skill).toContain(
      "Never put the notification route or Gateway credentials in the worker prompt or environment.",
    );
    expect(skill).toContain("Keep this route only in the parent context:");
    expect(skill).toContain("Parent route:");
    expect(skill).not.toContain("Worker must send completion/failure via `openclaw message send`.");
    expect(skill).not.toContain(
      "When finished, send exactly one completion or failure message using:",
    );
  });
});
