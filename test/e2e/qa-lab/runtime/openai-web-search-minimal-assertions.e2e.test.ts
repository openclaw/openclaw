// OpenAI web-search minimal assertion tests cover QA Lab native web_search evidence.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/openai-web-search-minimal/assertions.mjs";
const PROMPT = "Return exactly OPENCLAW_SCHEMA_E2E_OK.";
// Independent synthetic bytes for the Gateway's marked compact-JSON framing.
const CONTEXT =
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"test-sender"}}\n```\n\n';
const FRAMED_PROMPT = `[Mon 2026-09-28 06:00 UTC] ${CONTEXT}${PROMPT}`;

function runAssertSuccessRequest(logPath: string) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-success-request", logPath], {
    encoding: "utf8",
  });
}

describe("openai web-search minimal assertions", () => {
  it.each([
    { tools: [{ type: "web_search" }], effort: "low", error: undefined },
    { tools: [{ type: "web_search" }], effort: "minimal", error: "avoid minimal reasoning" },
    {
      tools: [{ type: "function", name: "web_search" }],
      effort: "low",
      error: "include native web_search",
    },
  ])("selects the agent after an Activity recap ($effort, $error)", ({ tools, effort, error }) => {
    const dir = tempDirs.make("openclaw-web-search-activity-");
    const logPath = path.join(dir, "requests.jsonl");
    const prompt = PROMPT;
    const bodies = [
      { model: "gpt-5", input: [{ role: "user", content: `Summarize this activity: ${prompt}` }] },
      { model: "gpt-5-mini", input: prompt },
      {
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: FRAMED_PROMPT }],
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
  it.each([
    ["plain prompt", PROMPT, true],
    ["timestamp only", `[Mon 2026-09-28 06:00 UTC] ${PROMPT}`, true],
    ["context without timestamp", `${CONTEXT}${PROMPT}`, true],
    ["recap", `Summarize this activity: ${FRAMED_PROMPT}`, false],
    ["assistant role", FRAMED_PROMPT, false, "assistant"],
    ["wrong model", FRAMED_PROMPT, false, "user", "gpt-5-mini"],
    ["quoted turn", `"${FRAMED_PROMPT}"`, false],
    ["body prefix", `${CONTEXT}Quoted: ${PROMPT}`, false],
    ["body suffix", `${FRAMED_PROMPT} extra`, false],
    ["marker only in metadata", `${CONTEXT.replace("test-sender", PROMPT)}Other prompt`, false],
    ["unmarked heading", FRAMED_PROMPT.replace(" ⟦openclaw:ctx⟧", ""), false],
    ["invalid JSON", FRAMED_PROMPT.replace('{"sender":', "{sender:"), false],
    ["missing closing fence", FRAMED_PROMPT.replace("\n```\n\n", "\n\n"), false],
    ["missing separator", FRAMED_PROMPT.replace("\n```\n\n", "\n```\n"), false],
  ])(
    "matches only the exact prompt after documented framing: %s",
    (_name, input, accepted, role = "user", model = "gpt-5") => {
      const logPath = path.join(tempDirs.make("openclaw-web-search-framing-"), "requests.jsonl");
      const body = {
        model,
        input: [{ role, content: input }],
        tools: [{ type: "web_search" }],
        reasoning: { effort: "low" },
      };
      writeFileSync(logPath, JSON.stringify({ method: "POST", path: "/v1/responses", body }));
      const result = runAssertSuccessRequest(logPath);
      expect(result.status === 0).toBe(accepted);
      expect(result.stderr).toContain(accepted ? "" : "missing success request");
    },
  );
});
