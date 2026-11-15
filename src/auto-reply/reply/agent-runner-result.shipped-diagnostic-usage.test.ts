import fs from "node:fs";
import path from "node:path";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createTestFinalizationContext } from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

// A raw trace reply is assembled by finalizeReplyAgentRun, not by the reader.
// Drive that shipped path so the estimate is proven where a user sees it.
const archived = "x".repeat(4000);
const retained = "r".repeat(2000);
const summary = "s".repeat(500);
const tail = "short live tail";
const assistant = (text: string) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  content: text,
});
const message = (id: string, payload: unknown) =>
  JSON.stringify({ type: "message", id, message: payload });
const estimate = (...texts: string[]) =>
  estimateTokensFromChars(texts.reduce((sum, text) => sum + estimateStringChars(text), 0));

async function replyTexts(rows: string[]) {
  const root = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-shipped-diagnostic-");
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionFile, rows.join("\n"), "utf-8");
  const sessionKey = "agent:main:shipped-diagnostic";
  const sessionId = "shipped-diagnostic-session";
  const followupRun = createMockFollowupRun({
    prompt: "what is my context usage",
    run: {
      sessionKey,
      sessionId,
      sessionFile,
      traceAuthorized: true,
      traceLevelOverride: "raw",
    },
  });
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: root,
      sessionKey,
      incarnation: sessionId,
      agentId: "main",
    }),
  });
  replyOperation.setPhase("running");
  const context = createTestFinalizationContext(followupRun, replyOperation);
  context.storePath = path.join(root, "sessions.json");
  context.typingSignals = createTypingSignaler({
    typing: createMockTypingController(),
    mode: "never",
  });
  context.execution.result = {
    payloads: [],
    meta: { durationMs: 1, terminalReply: { disposition: "silent" } },
  };
  try {
    const reply = await finalizeReplyAgentRun(context);
    const payloads = Array.isArray(reply) ? reply : reply ? [reply] : [];
    return payloads.map((payload) => payload.text ?? "");
  } finally {
    replyOperation.complete();
  }
}

function sessionTotal(texts: string[]) {
  const rendered = texts.find((text) => text.includes("Usage (Session Total)"));
  return rendered?.split("🔎 Usage (Session Total):\n~~~text\n")[1]?.split("\n~~~")[0];
}

it("ships the retained-window estimate in a raw trace reply", async () => {
  const texts = await replyTexts([
    message("m-archived", assistant(archived)),
    message("m-retained", { role: "user", content: retained }),
    JSON.stringify({
      type: "compaction",
      id: "c-1",
      summary,
      firstKeptEntryId: "m-retained",
      tokensBefore: 1000,
    }),
    message("m-tail", assistant(tail)),
  ]);

  const expected = estimate(retained, summary, tail);
  expect(sessionTotal(texts)).toContain(`total=${expected.toLocaleString()} tok`);
  expect(expected).toBeLessThan(estimate(archived, retained, summary, tail));
});

it("ships a later per-call snapshot ahead of any estimate", async () => {
  const texts = await replyTexts([
    message("m-archived", assistant(archived)),
    JSON.stringify({ type: "compaction", id: "c-1" }),
    message("m-tail", { ...assistant(tail), usage: { input: 1000, cacheRead: 234 } }),
  ]);

  expect(sessionTotal(texts)).toContain("total=1,234 tok");
});
