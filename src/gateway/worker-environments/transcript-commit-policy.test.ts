import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import type { SessionMessageEntry } from "../../agents/sessions/session-manager-types.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { prepareTranscriptCommitFromSnapshot } from "./transcript-commit-policy.js";
import type { CommittedAgentMessage } from "./transcript-commit.types.js";

const RUN_ID = "worker-run";
const SESSION_ID = "worker-session";

function messageEntry(
  id: string,
  parentId: string | null,
  message: SessionMessageEntry["message"],
): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp: "2026-10-14T00:00:00.000Z", message };
}

function fixture(scenario = "same run") {
  const assistant = makeAgentAssistantMessage({
    model: "fixture",
    content: [{ type: "text", text: "Delivered reply" }],
    timestamp: 200,
  });
  const toolResult = makeTextToolResult("message-call", "message", "Delivered", false, 300);
  const runIdFor = (kind: string) =>
    scenario === `missing ${kind} run`
      ? undefined
      : scenario === `foreign ${kind} run`
        ? "foreign"
        : RUN_ID;
  const base = messageEntry(
    "base",
    null,
    attachSessionTranscriptRunId(assistant, runIdFor("base")),
  );
  const mirror = {
    ...assistant,
    api: "openclaw-transcript",
    idempotencyKey: "source-reply",
    provider: scenario === "foreign provider" ? "other" : "openclaw",
    model: scenario === "ordinary assistant" ? "other" : "delivery-mirror",
    __openclaw: { runId: runIdFor("mirror") },
  };
  const messages: [CommittedAgentMessage, CommittedAgentMessage] = [
    { ...toolResult, idempotencyKey: "worker-result" },
    {
      ...assistant,
      idempotencyKey: "worker-final",
      content: [{ type: "text", text: "Done" }],
    },
  ];
  const path = (suffix: string) => [
    messageEntry("mirror-before" + suffix, "base", mirror),
    messageEntry("result" + suffix, "mirror-before" + suffix, messages[0]),
    messageEntry("mirror-between" + suffix, "result" + suffix, mirror),
    messageEntry("final" + suffix, "mirror-between" + suffix, messages[1]),
  ];
  return {
    messages,
    commit: (recoverPersistedBatch: boolean, suffixes = [""]) => {
      const events = [
        { type: "session", version: CURRENT_SESSION_VERSION, id: SESSION_ID },
        base,
        ...suffixes.flatMap(path),
        ...(recoverPersistedBatch ? [winningUser] : []),
      ];
      return prepareTranscriptCommitFromSnapshot(
        {
          messages,
          runId: scenario === "missing run" ? undefined : scenario === "null run" ? null : RUN_ID,
          recoverPersistedBatch,
          scope: {
            agentId: "main",
            sessionId: SESSION_ID,
            sessionKey: "agent:main:test",
            storePath: "/fixture/sessions.json",
          },
          lifecycleRevision: "fixture",
          requestedBaseLeafId: "base",
          cwd: "/fixture",
        },
        { sessionId: SESSION_ID, updatedAt: 0, lifecycleRevision: "fixture" },
        () => ({
          events,
          version: { generation: "fixture", rawSeq: events.length, updatedAt: 0 },
        }),
      ).result;
    },
  };
}

const winningUser = messageEntry("winning-user", "base", makeUserMessage("Later input", 400));

describe.each([false, true])("worker mirror policy (recovery: %s)", (recoverPersistedBatch) => {
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
  ])("requires matching provenance across interleaved mirrors (%s)", (scenario) => {
    const { messages, commit } = fixture(scenario);
    const result = commit(recoverPersistedBatch);
    if (scenario !== "same run") {
      expect(result).toEqual({ ok: false, reason: "stale-base-leaf" });
      return;
    }
    expect(result).toEqual({
      ok: true,
      lifecycleRevision: "fixture",
      messages: messages.map((message, index) =>
        Object.assign(
          { appended: false, message, messageId: ["result", "final"][index] },
          !recoverPersistedBatch ? { messageSeq: 3 + index * 2 } : {},
        ),
      ),
    });
  });
});

it("rejects ambiguous complete batches behind same-run mirrors instead of choosing a branch", () => {
  expect(fixture().commit(true, ["-one", "-two"])).toEqual({ ok: false, reason: "invalid-batch" });
});
