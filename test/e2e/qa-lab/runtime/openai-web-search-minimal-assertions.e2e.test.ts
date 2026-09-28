// OpenAI web-search minimal assertion tests cover QA Lab native web_search evidence.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  it("accepts a success request with web_search and non-minimal reasoning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            model: "gpt-5",
            input: "Return exactly OPENCLAW_SCHEMA_E2E_OK.",
            reasoning: { effort: "low" },
            tools: [{ type: "web_search" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      expect(runAssertSuccessRequest(logPath).status).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each([
    { tools: [{ type: "web_search" }], effort: "low", error: undefined },
    { tools: [], effort: "low", error: "did not include native web_search" },
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

  it("finds success requests split across large scan chunks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({ path: "/health", body: { pad: "x".repeat(70 * 1024) } })}\n${JSON.stringify(
          {
            body: {
              model: "gpt-5",
              input: "Return exactly OPENCLAW_SCHEMA_E2E_OK.",
              reasoning: { effort: "low" },
              tools: [{ type: "web_search" }],
            },
            method: "POST",
            path: "/v1/responses",
          },
        )}\n`,
      );

      expect(runAssertSuccessRequest(logPath).status).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bounds diagnostics when the OpenAI responses endpoint was not used", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            old: `DO_NOT_DUMP_OLD_REQUESTS${"x".repeat(70 * 1024)}`,
          },
          path: "/health",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Request log tail:");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_REQUESTS");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bounds diagnostics when no success response is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            input: `DO_NOT_DUMP_OLD_RESPONSE${"x".repeat(70 * 1024)}recent response tail`,
            tools: [{ type: "web_search" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Recent /v1/responses:");
      expect(result.stderr).toContain("recent response tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_RESPONSE");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("rejects function-shaped web_search as native Responses proof", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            model: "gpt-5",
            input: "Return exactly OPENCLAW_SCHEMA_E2E_OK.",
            reasoning: { effort: "low" },
            tools: [{ name: "web_search", type: "function" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("success request did not include native web_search");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
