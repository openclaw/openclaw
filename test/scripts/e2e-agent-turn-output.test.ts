import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
  extractAgentReplyTexts,
} from "../../scripts/e2e/lib/agent-turn-output.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const marker = "OPENCLAW_E2E_OK";
const reply = (text = marker) => ({ payloads: [{ text }] });
const errorPayloads = [{ isError: true, text: marker }];
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

it("extracts local and gateway agent reply payload text", () => {
  expect(extract({ ...reply("local"), meta: { finalAssistantVisibleText: "visible" } })).toEqual([
    "visible",
    "local",
  ]);
  expect(
    extract({ result: { ...reply("gateway"), meta: { finalAssistantRawText: "raw" } } }),
  ).toEqual(["raw", "gateway"]);
});

it("does not accept reply-shaped JSON embedded in diagnostic lines", () => {
  rejectReply(`echo ${JSON.stringify(reply())}\n${JSON.stringify(reply("unmarked"))}`);
});

it.each([
  ["error payload text", { payloads: [...errorPayloads, { text: "unmarked" }] }],
  [
    "failed result meta text",
    {
      result: {
        status: "error",
        meta: { finalAssistantVisibleText: marker },
        payloads: errorPayloads,
      },
    },
  ],
])("does not accept markers that only appear in %s", (_name, payload) => {
  rejectReply(JSON.stringify(payload));
});

it("does not accept markers mirrored into blocked run metadata", () => {
  expect(
    extract({
      payloads: errorPayloads,
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
    `${JSON.stringify(reply())}\n${"x".repeat(2_200_000)}\n${JSON.stringify(reply("unmarked"))}`,
  );
});

it("rejects a mock OpenAI endpoint that was never hit", () => {
  const logPath = writeLog(`${JSON.stringify({ path: "/health" })}\n`);
  expect(() => assertOpenAiRequestLogUsed(logPath)).toThrow(/was not used/u);
});

it("finds OpenAI request paths split across large log scan chunks", () => {
  const pathPrefix = "/v1/res";
  const logPath = writeLog(`${"x".repeat(64 * 1024 - pathPrefix.length)}${pathPrefix}ponses\n`);
  expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();
});
