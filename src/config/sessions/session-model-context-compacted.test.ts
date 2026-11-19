import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  CompactedContextWorkerInput,
  CompactedContextWorkerResult,
} from "./session-model-context-compacted.test-support.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

async function readWorker(
  input: CompactedContextWorkerInput,
): Promise<CompactedContextWorkerResult> {
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`;
  const worker = new Worker(
    new URL("./session-model-context-compacted.test-support.ts", import.meta.url),
    {
      workerData: input,
      execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
    },
  );
  const exited = once(worker, "exit");
  try {
    const [result] = await once(worker, "message");
    await exited;
    return result as CompactedContextWorkerResult;
  } finally {
    await worker.terminate();
  }
}

const cases = [
  "compaction",
  "prior-reset",
  "reset",
  "branch",
  "pending",
  "placed",
  "restart",
  "missing-facts",
  "stale",
  "prefix-model",
  "fence",
  "anchor",
  "no-boundary",
] as const;
it.each(cases)("preserves exact model bytes for %s and bounds eligible navigation", (kind) =>
  withOpenClawTestState({ label: `compacted-model-${kind}` }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: kind,
      sessionKey: `agent:main:${kind}`,
      storePath: state.statePath("transcript.sqlite"),
    };
    const timestamp = "2026-01-01T00:00:00.000Z";
    await importSqliteSessionRowsBatch([
      {
        ...scope,
        entry: { sessionId: kind, updatedAt: 1 },
        transcriptMtimeMs: 1,
        readTranscriptEvents(append) {
          append({ type: "session", id: kind, version: 3, timestamp, cwd: "/synthetic" });
          let parentId: string | null = null;
          const add = (id: string, event: Record<string, unknown>) => {
            append({ id, parentId, timestamp, ...event });
            parentId = id;
          };
          add("thinking", { type: "thinking_level_change", thinkingLevel: "high" });
          for (let turn = 0; turn < 80; turn++) {
            add(`user-${turn}`, {
              type: "message",
              message: { role: "user", content: `Question ${turn}`, timestamp: turn },
            });
            add(`assistant-${turn}`, {
              type: "message",
              message: {
                role: "assistant",
                provider: "openai",
                model: "synthetic",
                timestamp: turn,
                content: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: {} }],
                providerReplay: {
                  type: "openai-responses-compaction",
                  replayIndex: 0,
                  id: "synthetic-checkpoint",
                },
              },
            });
            if (turn === 79) {
              add("synthetic-result", {
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: `call-${turn}`,
                  toolName: "read",
                  timestamp: turn,
                  content: [{ type: "text", text: "Missing result" }],
                  isError: true,
                  details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true },
                },
              });
            }
            add(`result-${turn}`, {
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: `call-${turn}`,
                toolName: "read",
                timestamp: turn,
                content: [
                  { type: "text", text: (turn % 2 ? "synthetic\0" : "synthetic").repeat(2048) },
                  { type: "image", data: "a".repeat(256), mimeType: "image/png" },
                ],
                details: { private: "not-model-input" },
              },
            });
            if (turn === 1 && (kind === "pending" || kind === "placed")) {
              add("pending", {
                type: "message",
                message: {
                  role: "assistant",
                  provider: "openclaw",
                  model: "automation-result",
                  excludeFromContext: true,
                  openclawModelPlacement: "pending",
                  content: [{ type: "text", text: "Accepted background result" }],
                  timestamp: 1,
                },
              });
            }
            if (turn === 1 && kind === "restart") {
              add("restart", {
                type: "custom",
                customType: "openclaw.system-prompt",
                data: { restart: true },
              });
            }
            if (turn === 1 && kind === "branch") {
              append({
                type: "message",
                id: "abandoned",
                parentId,
                appendMode: "side",
                timestamp,
                message: { role: "user", content: "Abandoned branch", timestamp: 1 },
              });
            }
            if (turn === 20 && kind === "prior-reset") {
              add("old-reset", { type: "reset", reason: "new", firstKeptEntryId: "old-reset" });
            }
            if (turn === 40 && kind === "prior-reset") {
              add("old-compaction", {
                type: "compaction",
                firstKeptEntryId: "user-40",
                summary: "Older summary",
                tokensBefore: 1000,
              });
            }
          }
          if (kind !== "no-boundary") {
            add("boundary", {
              type: kind === "reset" ? "reset" : "compaction",
              firstKeptEntryId: kind === "prefix-model" ? "boundary" : "user-78",
              summary: "Earlier conversation",
              reason: "new",
              tokensBefore: 10000,
            });
          }
          if (kind === "placed") {
            add("placement", {
              type: "custom",
              customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
              data: { afterEntryId: parentId, resultEntryIds: ["pending"] },
            });
          }
          add("latest", {
            type: "message",
            message: { role: "user", content: "Continue", timestamp: 100 },
          });
        },
      },
    ]);
    if (kind === "missing-facts" || kind === "stale") {
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          db.prepare(
            kind === "missing-facts"
              ? "DELETE FROM session_transcript_active_event_facts WHERE session_id=? AND seq=3"
              : "UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id=?",
          ).run(kind);
        },
        toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
      );
    }
    const anchor =
      kind === "fence" || kind === "anchor"
        ? await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: "latest" })
        : undefined;
    if (kind === "fence" || kind === "anchor") {
      assert(anchor);
    }
    const through = kind === "anchor" ? anchor : undefined;
    const admission =
      kind === "fence" && anchor
        ? { ...anchor, role: "user" as const, logicalTurnId: "synthetic-turn" }
        : undefined;
    const requests: CompactedContextWorkerInput["requests"] = [false, true].map((omit) => ({
      limits: {
        maxBytes: omit ? 24_000 : 100_000,
        maxEvents: 100,
        toolResultOverflow: omit ? "omit" : undefined,
      },
      through,
      admission,
    }));
    // The supported synchronous caller retains the original full-navigation implementation.
    const expected = requests.map((request) =>
      JSON.stringify(
        runWithSessionTranscriptReadFence(request.admission, () =>
          readSessionTranscriptModelContext(scope, request.through, request.limits),
        ),
      ),
    );
    const actual = await readWorker({ scope, requests });
    expect(actual.map((result) => result.json)).toEqual(expected);
    if (kind === "compaction" || kind === "branch" || kind === "prior-reset") {
      expect(actual[0]!.navigationRows).toBeLessThan(20);
      expect(actual[1]!.navigationRows).toBeLessThan(20);
    }
  }),
);

it("keeps discarded-prefix projected costs when there is no semantic boundary", () =>
  withOpenClawTestState({ label: "compacted-cost-counterexample" }, async (state) => {
    const outputs: string[] = [];
    for (const size of [2000, 10000]) {
      const scope = {
        agentId: "main",
        sessionId: `cost-${size}`,
        sessionKey: `agent:main:cost-${size}`,
        storePath: state.statePath("cost.sqlite"),
      };
      await importSqliteSessionRowsBatch([
        {
          ...scope,
          entry: { sessionId: scope.sessionId, updatedAt: 1 },
          transcriptMtimeMs: 1,
          readTranscriptEvents(append) {
            const timestamp = "2026-01-01T00:00:00.000Z";
            append({
              type: "session",
              version: 3,
              id: "same-header",
              cwd: "/synthetic",
              timestamp,
            });
            let parentId: string | null = null;
            let seq = 0;
            for (let turn = 0; turn < 20; turn++) {
              for (const message of [
                { role: "user", content: `question ${turn}`, timestamp: 1 },
                {
                  role: "assistant",
                  content: [{ type: "toolCall", id: `call${turn}`, name: "read", arguments: {} }],
                  provider: "openai",
                  model: "synthetic",
                  stopReason: "toolUse",
                  timestamp: 1,
                },
                {
                  role: "toolResult",
                  toolCallId: `call${turn}`,
                  toolName: "read",
                  content: [{ type: "text", text: "x".repeat(turn === 0 ? size : 5000) + "\0" }],
                  details: { private: "x".repeat(turn === 0 ? 20000 - size : 100) },
                  isError: false,
                  timestamp: 1,
                },
              ]) {
                const id = `e${++seq}`;
                append({ type: "message", id, parentId, timestamp, message });
                parentId = id;
              }
            }
          },
        },
      ]);
      const request = { limits: { maxBytes: 12127, maxEvents: 10000 } };
      const expected = JSON.stringify(
        readSessionTranscriptModelContext(scope, undefined, request.limits),
      );
      const [actual] = await readWorker({ scope, requests: [request] });
      expect(actual!.json).toBe(expected);
      const events = (JSON.parse(actual!.json) as { events: Array<{ id: string }> }).events;
      expect(events.some((event) => event.id === "e3")).toBe(false);
      outputs.push(events.map((event) => event.id).join(","));
    }
    expect(outputs).toEqual(["same-header,e58,e59,e60", "same-header,e55,e56,e57,e58,e59,e60"]);
  }));
