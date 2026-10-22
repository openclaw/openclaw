import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("pending-input-mirror-replay-");
const receipts: SessionPendingInputReceipt[] = [];
afterEach(async () => {
  for (const receipt of receipts.splice(0)) {
    receipt.finish("interrupted");
    await receipt.settled?.();
  }
  await closeOpenClawAgentDatabasesAsync();
});

async function commitMirroredInput() {
  const runId = "announce:settle-workers";
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:subagent:lead",
    sessionId: "lead-session",
    storePath: fixture.storePath(),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    lifecycleRevision: "lead-lifecycle",
    activeWriterRunId: runId,
    updatedAt: 1,
  });
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Worker integration ready",
      display: false,
      idempotencyKey: `${runId}:user`,
      requesterOrigin: { operatorProfileId: "gateway-owner", sessionKey: scope.sessionKey },
      provenance: {
        kind: "inter_session",
        sourceTool: "subagent_settle",
        sourceSessionKey: "worker-b",
      },
    },
    target: { ...scope, sessionEntry: loadSessionEntry(scope) },
    trackInputCompletion: true,
  });
  expect(await recorder.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
  await recorder.persistApproved();
  const original = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "admitted input"),
  );
  const annotate = expectDefined(
    bindUserTurnTranscriptAnnotation({ recorder, target: scope, runId, assertCurrent: () => {} }),
    "native annotation owner",
  );
  const upstreamUserText = "Native harness context\nWorker integration ready";
  await annotate({
    mirrorIdentity: "native-turn:prompt",
    mirrorOrigin: "codex-app-server",
    upstreamUserText,
    mirrorSourceFingerprint: createHash("sha256")
      .update(JSON.stringify({ role: "user", content: original.content, upstreamUserText }))
      .digest("hex")
      .slice(0, 32),
  });
  const committed = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "native prompt"),
  );
  const transcript = await loadTranscriptEvents(scope);
  recorder.finishPendingInput?.("interrupted");
  await closeOpenClawAgentDatabasesAsync();
  rotateAgentEventLifecycleGeneration();
  const replay = async (message: PersistedUserTurnMessage = original) => {
    const receipt = await stageSessionPendingInput(scope, {
      runId,
      message,
      trackCompletion: true,
      replaySourceSessionKeys: ["worker-a", "worker-b"],
      assertCurrent: () => {},
    });
    if (receipt) {
      receipts.push(receipt);
    }
    return expectDefined(receipt, "replayed input");
  };
  return { scope, original, committed, transcript, replay };
}

it("replays a committed native prompt without duplicating the mirrored input", async () => {
  const { scope, original, committed, transcript, replay } = await commitMirroredInput();
  const receipt = await replay({
    ...original,
    provenance: { ...original.provenance, kind: "inter_session", sourceSessionKey: "worker-a" },
  });
  expect(receipt.message).toEqual(committed);
  expect(receipt.run(() => "continued")).toBe("continued");
  const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
  await expect(receipt.completeAsync!(outcome)).resolves.toEqual(outcome);
  expect(await loadTranscriptEvents(scope)).toEqual(transcript);
});

it("still rejects changed completion content and requester facts against a native prompt", async () => {
  const { scope, original, transcript, replay } = await commitMirroredInput();
  const requesterOrigin = expectDefined(
    original["__openclaw"]?.requesterOrigin,
    "requester origin",
  );
  const changed: PersistedUserTurnMessage[] = [
    { ...original, content: "Different result" },
    {
      ...original,
      __openclaw: {
        ...original["__openclaw"],
        requesterOrigin: { ...requesterOrigin, operatorProfileId: "other" },
      },
    },
    { ...original, __openclaw: { ...original["__openclaw"], unexpected: "extra metadata" } },
  ];
  for (const message of changed) {
    await expect(replay(message)).rejects.toThrow(/conflicts|does not match/);
  }
  expect(await loadTranscriptEvents(scope)).toEqual(transcript);
});
