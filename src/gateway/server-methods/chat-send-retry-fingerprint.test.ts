import { describe, expect, it } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  deleteSessionEntryLifecycle,
  listSessionPendingInputs,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { loadDeviceIdentityIfPresentAsync } from "../../infra/device-identity-async.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function expectStarted(fixture: Fixture, runId?: string) {
  expect(await fixture.send()).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started", ...(runId ? { runId } : {}) }),
    undefined,
    expect.anything(),
  );
}

async function expectConflict(fixture: Fixture, code?: string) {
  expect(await fixture.send()).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      ...(code ? { code } : {}),
      details: { reason: "chat-request-conflict" },
    }),
  );
}

async function expectUnchanged(
  fixture: Fixture,
  transcript: ReturnType<Fixture["readTranscript"]>,
  receipts: Awaited<ReturnType<typeof listSessionPendingInputs>>,
) {
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(fixture.readTranscript()).toEqual(transcript);
  expect(await listSessionPendingInputs(fixture.scope)).toEqual(receipts);
}

describe("chat.send persisted request identity", () => {
  it.each([
    { mode: "ordinary", queueMode: undefined, state: "replaced" },
    { mode: "steer", queueMode: "steer" as const, state: "missing" },
  ])("refuses a $state physical session for $mode input", async ({ queueMode, state }) => {
    await using fixture = await createFixture({
      preserveContent: true,
      active: state !== "missing",
    });
    if (state === "missing") {
      await deleteSessionEntryLifecycle({
        agentId: fixture.scope.agentId,
        storePath: fixture.scope.storePath,
        archiveTranscript: false,
        target: { canonicalKey: fixture.scope.sessionKey, storeKeys: [fixture.scope.sessionKey] },
      });
      expect(loadSessionEntry(fixture.scope)).toBeUndefined();
    }
    const transcript = fixture.readTranscript();
    const receipts = await listSessionPendingInputs(fixture.scope);
    fixture.params.queueMode = queueMode;
    fixture.params.sessionId = state === "missing" ? fixture.scope.sessionId : "replaced-session";

    expect(await fixture.send()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: `Error: Session "${fixture.scope.sessionKey}" changed while starting work. Retry.`,
      }),
    );
    await expectUnchanged(fixture, transcript, receipts);
    if (state === "missing") {
      expect(loadSessionEntry(fixture.scope)).toBeUndefined();
    }

    if (state === "missing") {
      delete fixture.params.sessionId;
    } else {
      fixture.params.sessionId = fixture.scope.sessionId;
    }
    fixture.params.idempotencyKey = "current-physical-session";
    await expectStarted(fixture, "current-physical-session");
    await fixture.finishDispatch();
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  });

  it.each([
    { source: "transcript", input: "override", storage: "durable" },
    { source: "transcript", input: "override", storage: "memory" },
    { source: "input receipt", input: "attachment", storage: "durable" },
    { source: "input receipt", input: "attachment", storage: "memory" },
    { source: "transcript", input: "command", storage: "durable" },
  ] as const)(
    "deduplicates a non-restart-safe $input from its $source in $storage after RAM identity expires",
    async ({ source, input, storage }) => {
      await using fixture = await createFixture({ preserveContent: true, storage });
      if (input === "override") {
        fixture.params.thinking = "high";
      } else if (input === "attachment") {
        fixture.params.attachments = [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "retry.txt",
            content: Buffer.from("Keep the original attachment.").toString("base64"),
          },
        ];
      } else {
        fixture.params.message = "/status";
      }
      await expectStarted(fixture);
      const recorder = await fixture.dispatchedRecorder;
      if (source === "transcript") {
        expect((await recorder.persistApproved())?.appended).toBe(true);
      } else {
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
      }
      await fixture.finishDispatch();
      const transcript = fixture.readTranscript();
      const receipts = await listSessionPendingInputs(fixture.scope);
      expect(receipts.total).toBe(source === "transcript" ? 0 : 1);
      fixture.context.dedupe.clear();
      dispatchInboundMessageMock.mockClear();

      expect(await fixture.send()).toHaveBeenCalledWith(
        true,
        {
          runId: fixture.params.idempotencyKey,
          status: "ok",
          ...(source === "transcript" ? { messageSeq: 2 } : {}),
        },
        undefined,
        expect.objectContaining({ cached: true }),
      );
      const editedMessage = `${fixture.params.message} Edited input.`;
      for (const message of [editedMessage, "/stop"]) {
        fixture.params.message = message;
        await expectConflict(fixture);
      }
      fixture.params.message = "Start a different goal.";
      fixture.params.thinking = undefined;
      fixture.params.attachments = undefined;
      fixture.params.intent = { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() };
      await expectConflict(fixture);
      delete fixture.params.intent;
      fixture.params.thinking = "high";
      await expectUnchanged(fixture, transcript, receipts);

      fixture.params.idempotencyKey = "fresh-browser-follow-up";
      fixture.params.message = editedMessage;
      await expectStarted(fixture, "fresh-browser-follow-up");
      await fixture.finishDispatch();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { preserveContent: true, deviceIdentity: true },
    { preserveContent: false, deviceIdentity: true },
    { preserveContent: true, deviceIdentity: false },
  ])(
    "preserves retry comparison after SQLite reopens and RAM identity expires (original text retained: $preserveContent, device identity: $deviceIdentity)",
    async ({ preserveContent, deviceIdentity }) => {
      await using fixture = await createFixture({ preserveContent, deviceIdentity });
      if (!deviceIdentity) {
        expect(await loadDeviceIdentityIfPresentAsync()).toBeNull();
      }
      const first = await fixture.send();
      expect(first.mock.calls[0]?.[0]).toBe(true);
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.appended).toBe(true);
      if (deviceIdentity) {
        expect(committed?.message).toHaveProperty(
          "__openclaw.chatRequestIdentity",
          expect.stringMatching(/^[a-f0-9]{64}$/u),
        );
      } else {
        expect(committed?.message).not.toHaveProperty("__openclaw.chatRequestIdentity");
      }
      expect(committed?.message.content).toBe(
        preserveContent ? fixture.params.message : fixture.approvedContent,
      );
      expect(
        abortChatRunById(createChatAbortOps(fixture.context), {
          sessionKey: fixture.scope.sessionKey,
          runId: fixture.params.idempotencyKey,
          stopReason: "rpc",
        }),
      ).toEqual({ aborted: true });
      await fixture.finishDispatch();
      fixture.context.dedupe.clear();
      await closeOpenClawAgentDatabaseByPathAsync(
        resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
        fixture.scope.agentId,
      );
      dispatchInboundMessageMock.mockClear();

      const replay = await fixture.send();
      const replayResponse = [
        true,
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          status: "timeout",
          summary: "aborted",
        }),
        undefined,
        expect.objectContaining({ cached: true }),
      ] as const;
      expect(replay).toHaveBeenCalledWith(...replayResponse);
      fixture.context.dedupe.clear();
      fixture.params.message += " Edited input.";
      if (deviceIdentity) {
        await expectConflict(fixture, "INVALID_REQUEST");
      } else {
        expect(await fixture.send()).toHaveBeenCalledWith(...replayResponse);
      }
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    },
  );
});
