import fs from "node:fs";
import path from "node:path";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import { createMockFollowupRun } from "./test-helpers.js";

// The raw diagnostic reads legacy JSONL artifacts, where compaction supersedes
// history without deleting it. Only the live window belongs in the estimate.
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

async function renderSessionTotal(rows: string[]) {
  const root = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-raw-diagnostic-");
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionFile, rows.join("\n"), "utf-8");
  const payload = await buildReplyDiagnosticsPayload({
    activeSessionEntry: undefined,
    followupRun: createMockFollowupRun({
      run: {
        sessionId: "raw-diagnostic-session",
        sessionFile,
        traceAuthorized: true,
        traceLevelOverride: "raw",
      },
    }),
    accounting: {
      runResult: { meta: { durationMs: 0 } },
      providerUsed: "anthropic",
      modelUsed: "claude-sonnet-4-6",
      contextTokensUsed: 1000,
    },
    storePath: path.join(root, "sessions.json"),
    userText: "what is my context usage",
  });
  return payload?.text?.split("🔎 Usage (Session Total):\n~~~text\n")[1]?.split("\n~~~")[0];
}

describe("raw reply diagnostic session usage from a JSONL artifact", () => {
  it("reports the retained window, not the superseded archive", async () => {
    const total = await renderSessionTotal([
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
    expect(total).toContain(`total=${expected.toLocaleString()} tok`);
    expect(expected).toBeLessThan(estimate(archived, retained, summary, tail));
  });

  it("keeps a later per-call snapshot ahead of any estimate", async () => {
    const total = await renderSessionTotal([
      message("m-archived", assistant(archived)),
      JSON.stringify({ type: "compaction", id: "c-1" }),
      message("m-tail", {
        ...assistant(tail),
        usage: { input: 1000, cacheRead: 234 },
      }),
    ]);

    expect(total).toContain("total=1,234 tok");
  });
});
