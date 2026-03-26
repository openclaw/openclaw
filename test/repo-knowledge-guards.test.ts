import { describe, expect, it } from "vitest";
import {
  collectRepoKnowledgeGuardViolations,
  findRepoKnowledgeGuardViolations,
  main,
} from "../scripts/check-repo-knowledge-guards.mjs";

function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

describe("repo knowledge guards", () => {
  it("flags missing frontmatter fields", () => {
    const violations = findRepoKnowledgeGuardViolations({
      file: "docs/exec-plans/example-plan.md",
      text: "---\nsummary: test\n---\n\n# Title\n",
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining("owner") }),
        expect.objectContaining({ reason: expect.stringContaining("freshness") }),
        expect.objectContaining({ reason: expect.stringContaining("last_reviewed") }),
      ]),
    );
  });

  it("repo knowledge docs satisfy the guard", async () => {
    expect(await collectRepoKnowledgeGuardViolations()).toEqual([]);
  });

  it("script json output matches the collector", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});
