import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../packages/ai/src/types.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import type { SessionMessageEntry } from "../../agents/sessions/session-manager-types.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { prepareTranscriptCommitFromSnapshot } from "./transcript-commit-policy.js";
import type { CommittedAgentMessage, TranscriptCommitInput } from "./transcript-commit.types.js";

const RUN_ID = "worker-run";
const SESSION_ID = "worker-session";
const SCOPE = {
  agentId: "main",
  sessionId: SESSION_ID,
  sessionKey: "agent:main:test",
  storePath: "/fixture/sessions.json",
};

function messageEntry(
  id: string,
  parentId: string | null,
  message: SessionMessageEntry["message"],
): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp: "2026-10-14T00:00:00.000Z", message };
}

function fixture(scenario = "same run") {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    stopReason: "stop",
    content: [{ type: "text", text: "Delivered reply" }],
    usage: createZeroUsageFixture(),
    timestamp: 200,
  };
  const toolResult = makeTextToolResult("message-call", "message", "Delivered", false, 300);
  const baseRunId =
    scenario === "missing base run"
      ? undefined
      : scenario === "foreign base run"
        ? "foreign"
        : RUN_ID;
  const mirrorRunId =
    scenario === "missing mirror run"
      ? undefined
      : scenario === "foreign mirror run"
        ? "foreign"
        : RUN_ID;
  const base = messageEntry("base", null, attachSessionTranscriptRunId(assistant, baseRunId));
  const mirror = {
    ...assistant,
    api: "openclaw-transcript",
    idempotencyKey: "source-reply",
    provider: scenario === "foreign provider" ? "other" : "openclaw",
    model: scenario === "ordinary assistant" ? "other" : "delivery-mirror",
    __openclaw: { runId: mirrorRunId },
  };
  const messages: [CommittedAgentMessage, CommittedAgentMessage] = [
    { ...toolResult, idempotencyKey: "worker-result" },
    {
      ...assistant,
      idempotencyKey: "worker-final",
      stopReason: "stop",
      content: [{ type: "text", text: "Done" }],
    },
  ];
  const path = (suffix: string) => [
    messageEntry("mirror-before" + suffix, "base", mirror),
    messageEntry("result" + suffix, "mirror-before" + suffix, messages[0]),
    messageEntry("mirror-between" + suffix, "result" + suffix, mirror),
    messageEntry("final" + suffix, "mirror-between" + suffix, messages[1]),
  ];
  return { base, messages, path };
}

function prepare(
  input: Pick<TranscriptCommitInput, "messages" | "runId" | "recoverPersistedBatch">,
  events: unknown[],
) {
  return prepareTranscriptCommitFromSnapshot(
    {
      ...input,
      scope: SCOPE,
      lifecycleRevision: "fixture",
      requestedBaseLeafId: "base",
      cwd: "/fixture",
    },
    { sessionId: SESSION_ID, updatedAt: 0, lifecycleRevision: "fixture" },
    () => ({
      events: [{ type: "session", version: CURRENT_SESSION_VERSION, id: SESSION_ID }, ...events],
      version: { generation: "fixture", rawSeq: events.length + 1, updatedAt: 0 },
    }),
  ).result;
}

describe.each([false, true])(
  "worker mirror policy (pending recovery: %s)",
  (recoverPersistedBatch) => {
    it.each([
      "same run",
      "missing run",
      "null run",
      "missing base run",
      "foreign base run",
      "missing mirror run",
      "foreign mirror run",
      "ordinary assistant",
      "foreign provider",
    ])(
      "crosses interleaved mirrors only with matching base and mirror provenance (%s)",
      (scenario) => {
        const { base, messages, path } = fixture(scenario);
        const events = [base, ...path("")];
        if (recoverPersistedBatch) {
          events.push(
            messageEntry("winning-user", "base", {
              role: "user",
              content: "Later input",
              timestamp: 400,
            }),
          );
        }
        const result = prepare(
          {
            messages,
            runId: scenario === "missing run" ? undefined : scenario === "null run" ? null : RUN_ID,
            recoverPersistedBatch,
          },
          events,
        );
        if (scenario !== "same run") {
          expect(result).toEqual({ ok: false, reason: "stale-base-leaf" });
          return;
        }
        expect(result).toEqual({
          ok: true,
          lifecycleRevision: "fixture",
          messages: [
            {
              appended: false,
              message: messages[0],
              messageId: "result",
              ...(!recoverPersistedBatch ? { messageSeq: 3 } : {}),
            },
            {
              appended: false,
              message: messages[1],
              messageId: "final",
              ...(!recoverPersistedBatch ? { messageSeq: 5 } : {}),
            },
          ],
        });
      },
    );
  },
);

it("rejects ambiguous complete batches behind same-run mirrors instead of choosing a branch", () => {
  const { base, messages, path } = fixture();
  expect(
    prepare({ messages, runId: RUN_ID, recoverPersistedBatch: true }, [
      base,
      ...path("-one"),
      ...path("-two"),
      messageEntry("winning-user", "base", {
        role: "user",
        content: "Later input",
        timestamp: 400,
      }),
    ]),
  ).toEqual({ ok: false, reason: "invalid-batch" });
});
