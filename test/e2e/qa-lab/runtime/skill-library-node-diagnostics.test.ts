import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { withTempDir } from "../../../../src/test-utils/temp-dir.js";
import { readSkillLibraryNodeDiagnostics } from "./skill-library-node-diagnostics.js";

it("captures bounded node logs with forced egress redaction and no partial record", async () => {
  await withTempDir("skill-node-diagnostics-", async (dir) => {
    const logFile = dir + "/node.log";
    await fs.writeFile(
      logFile,
      "x".repeat(20_000) +
        "\n" +
        JSON.stringify({
          message: "environment stop failed",
          password: "synthetic-node-password",
          authorization: "Bearer synthetic-authorization-token",
        }) +
        '\n{"password":"unfinished-private-record',
    );
    const start = performance.now();
    const result = await readSkillLibraryNodeDiagnostics(
      {
        logFile,
        logs: () =>
          'password=synthetic-stdio-password\nnode stop UNAVAILABLE\n{"password":"unfinished-stdio-credential',
      },
      "replacement-result",
    );
    expect(result.stage).toBe("replacement-result");
    expect(result.capturedAtMonotonicMs).toBeGreaterThanOrEqual(start);
    expect(result.capturedAtMonotonicMs).toBeLessThanOrEqual(performance.now());
    const output = JSON.stringify(result);
    expect(output).toContain("environment stop failed");
    expect(output).toContain("node stop UNAVAILABLE");
    expect(output).not.toContain("xxxxxxxx");
    expect(output).not.toContain("synthetic-node-password");
    expect(output).not.toContain("synthetic-authorization-token");
    expect(output).not.toContain("synthetic-stdio-password");
    expect(output).not.toContain("unfinished-private-record");
    expect(output).not.toContain("unfinished-stdio-credential");
    expect(output.length).toBeLessThan(16_384);
  });
});

it("reports missing node logs without exposing file paths", async () => {
  const result = await readSkillLibraryNodeDiagnostics(
    {
      logFile: "/not-a-real-private-node-state/node.log",
      logs: () => "",
    },
    "cancellation-result",
  );
  expect(result.nodeLog).toEqual(["[node log unavailable]"]);
  expect(JSON.stringify(result)).not.toContain("not-a-real-private-node-state");
});
