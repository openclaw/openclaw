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

describe("openai web-search minimal rejection log", () => {
  const record =
    '2026-11-02T00:00:00.000Z [provider-error] Model request failed sessionKey="agent:main:openai-web-search-minimal:reject" runId="schema-reject" provider=openai model=gpt-5 status=400 code=invalid_request_error type=invalid_request_error';
  it.each([
    ["controlled rejection without provider prose", record, true],
    ["other session", record.replace(":reject", ":other"), false],
    ["other run", record.replace('runId="schema-reject"', 'runId="other"'), false],
    ["other provider", record.replace("provider=openai", "provider=other"), false],
    ["other model", record.replace("model=gpt-5", "model=gpt-5-mini"), false],
    ["other status", record.replace("status=400", "status=4000"), false],
    ["other code", record.replace("code=invalid_request_error", "code=other"), false],
    ["other type", record.replace("type=invalid_request_error", "type=other"), false],
    ["other component", record.replace("[provider-error]", "[other]"), false],
    ["quoted record", `quoted: ${record}`, false],
    [
      "raw provider prose",
      "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.",
      false,
    ],
    [
      "separate records",
      `${record.replace(" status=400", "")}\n${record.replace('runId="schema-reject"', 'runId="other"')}`,
      false,
    ],
  ])("requires exact controlled rejection metadata: %s", (_name, text, accepted) => {
    const logPath = path.join(tempDirs.make("openclaw-web-search-reject-log-"), "gateway.log");
    writeFileSync(logPath, text);
    const result = spawnSync(
      process.execPath,
      [ASSERTIONS_SCRIPT, "assert-schema-reject-log", logPath],
      { encoding: "utf8" },
    );
    expect(result.status === 0).toBe(accepted);
    expect(result.stderr).toContain(accepted ? "" : "missing provider-error metadata");
  });
});
