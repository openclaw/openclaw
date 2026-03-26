import { describe, expect, it } from "vitest";
import {
  collectHarnessCoreBoundaryViolations,
  findHarnessCoreBoundaryViolations,
  main,
} from "../scripts/check-harness-core-boundaries.mjs";

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

describe("harness core boundary guards", () => {
  it("flags higher-layer imports in harness core files", () => {
    const violations = findHarnessCoreBoundaryViolations(
      'import { x } from "../auto-reply/reply/groups.js";\n',
      "/Users/frank/Documents/Projects/openclaw-main/src/agents/failure-rule-suggestions.ts",
    );
    expect(violations).toEqual([
      expect.objectContaining({
        kind: "import-boundary",
      }),
    ]);
  });

  it("repo harness core files satisfy the guard", async () => {
    expect(await collectHarnessCoreBoundaryViolations()).toEqual([]);
  });

  it("script json output matches the collector", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});
