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
const marker = "OPENCLAW_E2E_OK";
const reply = (text = marker) => ({ payloads: [{ text }] });
function writeLog(content: string) {
  const logPath = join(tempDirs.make("openclaw-e2e-output-"), "output.log");
  writeFileSync(logPath, content);
  return logPath;
}
function rejectReply(content: string) {
  const outputPath = writeLog(content);
  expect(() => assertAgentReplyContainsMarker(marker, outputPath)).toThrow(
    /agent reply payload did not contain marker/u,
  );
}
const extract = (value: object) => extractAgentReplyTexts(JSON.stringify(value));

describe("scripts/e2e/lib/agent-turn-output", () => {
  it("extracts local and gateway agent reply payload text", () => {
    expect(extract({ ...reply("local"), meta: { finalAssistantVisibleText: "visible" } })).toEqual([
      "visible",
      "local",
    ]);

    expect(
      extract({
        result: { ...reply("gateway"), meta: { finalAssistantRawText: "raw" } },
      }),
    ).toEqual(["raw", "gateway"]);
  });

  it("does not accept reply-shaped JSON embedded in diagnostic lines", () => {
    rejectReply([`echo ${JSON.stringify(reply())}`, JSON.stringify(reply("unmarked"))].join("\n"));
  });

  it.each([
    [
      "error payload text",
      {
        payloads: [{ isError: true, text: marker }, { text: "regular reply without marker" }],
      },
    ],
    [
      "failed result meta text",
      {
        result: {
          status: "error",
          meta: { finalAssistantVisibleText: marker },
          payloads: [{ isError: true, text: marker }],
        },
      },
    ],
  ])("does not accept markers that only appear in %s", (_name, payload) => {
    rejectReply(JSON.stringify(payload));
  });

  it("does not accept markers mirrored into blocked run metadata", () => {
    expect(
      extract({
        payloads: [{ isError: true, text: marker }],
        meta: {
          error: { message: marker },
          finalAssistantVisibleText: marker,
          livenessState: "blocked",
        },
      }),
    ).toEqual([]);
  });

  it("ignores stale reply markers outside the recent output tail", () => {
    rejectReply(
      [JSON.stringify(reply()), "x".repeat(2_200_000), JSON.stringify(reply("unmarked"))].join(
        "\n",
      ),
    );
  });

  it("checks that the mock OpenAI endpoint was actually hit", () => {
    const logPath = writeLog(`${JSON.stringify({ path: "/v1/responses" })}\n`);
    expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();

    writeFileSync(logPath, `${JSON.stringify({ path: "/health" })}\n`);
    expect(() => assertOpenAiRequestLogUsed(logPath)).toThrow(/was not used/u);
  });

  it("finds OpenAI request paths split across large log scan chunks", () => {
    const pathPrefix = "/v1/res";
    const logPath = writeLog(`${"x".repeat(64 * 1024 - pathPrefix.length)}${pathPrefix}ponses\n`);

    expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();
  });
});
