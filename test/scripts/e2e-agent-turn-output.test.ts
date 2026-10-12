import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
  extractAgentReplyTexts,
} from "../../scripts/e2e/lib/agent-turn-output.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scripts/e2e/lib/agent-turn-output", () => {
  it("extracts local and gateway agent reply payload text", () => {
    expect(
      extractAgentReplyTexts(
        JSON.stringify({
          payloads: [{ text: "OPENCLAW_E2E_OK_LOCAL" }],
          meta: { finalAssistantVisibleText: "visible" },
        }),
      ),
    ).toEqual(["visible", "OPENCLAW_E2E_OK_LOCAL"]);

    expect(
      extractAgentReplyTexts(
        JSON.stringify({
          result: {
            payloads: [{ text: "OPENCLAW_E2E_OK_GATEWAY" }],
            meta: { finalAssistantRawText: "raw" },
          },
        }),
      ),
    ).toEqual(["raw", "OPENCLAW_E2E_OK_GATEWAY"]);
  });

  it("does not accept reply-shaped JSON embedded in diagnostic lines", () => {
    const dir = tempDirs.make("openclaw-e2e-agent-output-");
    const outputPath = join(dir, "agent.log");
    writeFileSync(
      outputPath,
      [
        `echo ${JSON.stringify({ payloads: [{ text: "OPENCLAW_E2E_OK_DIAGNOSTIC" }] })}`,
        JSON.stringify({ payloads: [{ text: "real reply without marker" }] }),
      ].join("\n"),
    );

    expect(() => assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_DIAGNOSTIC", outputPath)).toThrow(
      /agent reply payload did not contain marker/u,
    );
  });

  it("does not accept markers that only appear in error payload text", () => {
    const dir = tempDirs.make("openclaw-e2e-agent-output-");
    const outputPath = join(dir, "agent.log");
    writeFileSync(
      outputPath,
      JSON.stringify({
        payloads: [
          { isError: true, text: "OPENCLAW_E2E_OK_ERROR_PAYLOAD" },
          { text: "regular reply without marker" },
        ],
      }),
    );

    expect(() =>
      assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_ERROR_PAYLOAD", outputPath),
    ).toThrow(/agent reply payload did not contain marker/u);
  });

  it("does not accept markers that only appear in failed result meta text", () => {
    const dir = tempDirs.make("openclaw-e2e-agent-output-");
    const outputPath = join(dir, "agent.log");
    writeFileSync(
      outputPath,
      JSON.stringify({
        result: {
          status: "error",
          meta: { finalAssistantVisibleText: "OPENCLAW_E2E_OK_ERROR_META" },
          payloads: [{ isError: true, text: "OPENCLAW_E2E_OK_ERROR_META" }],
        },
      }),
    );

    expect(() => assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_ERROR_META", outputPath)).toThrow(
      /agent reply payload did not contain marker/u,
    );
  });

  it("does not accept markers mirrored into blocked run metadata", () => {
    const marker = "OPENCLAW_E2E_OK_BLOCKED_META";

    expect(
      extractAgentReplyTexts(
        JSON.stringify({
          payloads: [{ isError: true, text: marker }],
          meta: {
            error: { message: marker },
            finalAssistantVisibleText: marker,
            livenessState: "blocked",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores stale reply markers outside the recent output tail", () => {
    const dir = tempDirs.make("openclaw-e2e-agent-output-");
    const outputPath = join(dir, "agent.log");
    writeFileSync(
      outputPath,
      [
        JSON.stringify({ payloads: [{ text: "OPENCLAW_E2E_OK_STALE" }] }),
        "x".repeat(2_200_000),
        JSON.stringify({ payloads: [{ text: "current reply without marker" }] }),
      ].join("\n"),
    );

    expect(() => assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_STALE", outputPath)).toThrow(
      /agent reply payload did not contain marker/u,
    );
  });

  it("checks that the mock OpenAI endpoint was actually hit", () => {
    const dir = tempDirs.make("openclaw-e2e-request-log-");
    const logPath = join(dir, "requests.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ path: "/v1/responses" })}\n`);
    expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();

    writeFileSync(logPath, `${JSON.stringify({ path: "/health" })}\n`);
    expect(() => assertOpenAiRequestLogUsed(logPath)).toThrow(/was not used/u);
  });

  it("finds OpenAI request paths split across large log scan chunks", () => {
    const dir = tempDirs.make("openclaw-e2e-request-log-");
    const logPath = join(dir, "requests.jsonl");
    const pathPrefix = "/v1/res";
    writeFileSync(logPath, `${"x".repeat(64 * 1024 - pathPrefix.length)}${pathPrefix}ponses\n`);

    expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();
  });
});
