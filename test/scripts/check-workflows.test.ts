import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("scripts/check-workflows.mjs", () => {
  it("explains how to recover when neither actionlint nor go is available", () => {
    const result = spawnSync(process.execPath, ["scripts/check-workflows.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/tmp/openclaw-no-workflow-tools",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("actionlint");
    expect(result.stderr).toContain("go");
    expect(result.stderr).toContain("Workflow sanity requires");
  });
});
