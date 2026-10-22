import { describe, expect, it } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
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

describe("chat.send persisted request identity", () => {
  it.each([
    { preserveContent: true, deviceIdentity: true },
    { preserveContent: false, deviceIdentity: true },
    { preserveContent: true, deviceIdentity: false },
  ])(
    "preserves retry comparison after SQLite reopens and RAM identity expires (original text retained: $preserveContent, device identity: $deviceIdentity)",
    async ({ preserveContent, deviceIdentity }) => {
      const fixture = await createFixture({ preserveContent, deviceIdentity });
      try {
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
        const edited = await fixture.send();
        if (deviceIdentity) {
          expect(edited).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              details: { reason: "chat-request-conflict" },
            }),
          );
        } else {
          expect(edited).toHaveBeenCalledWith(...replayResponse);
        }
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
