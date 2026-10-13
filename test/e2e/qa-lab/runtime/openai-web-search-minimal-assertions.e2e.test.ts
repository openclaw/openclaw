// OpenAI web-search minimal assertion tests cover QA Lab native web_search evidence.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/openai-web-search-minimal/assertions.mjs";

function runAssertSuccessRequest(logPath: string) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-success-request", logPath], {
    encoding: "utf8",
  });
}

describe("openai web-search minimal assertions", () => {
  it.each([
    { tools: [{ type: "web_search" }], effort: "low", error: undefined },
    { tools: [{ type: "web_search" }], effort: "minimal", error: "avoid minimal reasoning" },
  ])("selects the agent after an Activity recap ($effort, $error)", ({ tools, effort, error }) => {
    const dir = tempDirs.make("openclaw-web-search-activity-");
    const logPath = path.join(dir, "requests.jsonl");
    const prompt = "Return exactly OPENCLAW_SCHEMA_E2E_OK.";
    const bodies = [
      { model: "gpt-5", input: [{ role: "user", content: `Summarize this activity: ${prompt}` }] },
      { model: "gpt-5-mini", input: prompt },
      {
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: `[Mon 2026-09-28 06:00 UTC] ${prompt}` }],
          },
        ],
        reasoning: { effort },
        tools,
      },
    ];
    writeFileSync(
      logPath,
      bodies
        .map((body) => JSON.stringify({ method: "POST", path: "/v1/responses", body }))
        .join("\n"),
    );
    const result = runAssertSuccessRequest(logPath);
    if (error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    } else {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });
});
