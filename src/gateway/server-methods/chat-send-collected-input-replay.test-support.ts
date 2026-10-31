import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { expect, it } from "vitest";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import {
  setClientProfile,
  type useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";

type CreateFixture = ReturnType<typeof useBrowserFollowupFixture>;
type FollowupFixture = Awaited<ReturnType<CreateFixture>>;

export function registerChatCollectedInputReplayCases(
  createBrowserFollowupFixture: CreateFixture,
  admitPending: (fixture: FollowupFixture) => Promise<{
    recorder: Awaited<FollowupFixture["dispatchedRecorder"]>;
  }>,
) {
  const pending = (fixture: FollowupFixture) => listSessionPendingInputs(fixture.scope);

  it.each([
    { disposition: "consumed", recordedClient: true, legacy: false },
    ...["consumed", "changed-payload", "interrupted"].flatMap((disposition) =>
      [false, true].map((recordedClient) => ({ disposition, recordedClient, legacy: true })),
    ),
  ])(
    "preserves collected-input replay without adopting old custody ($disposition, legacy=$legacy, recordedClient=$recordedClient)",
    async ({ disposition, recordedClient, legacy }) => {
      await using fixture = await createBrowserFollowupFixture({ preserveContent: legacy });
      if (legacy) {
        setClientProfile(
          fixture.client,
          { ...ensureProfileForEmail("legacy-input@example.test"), updatedAt: 1 },
          "Legacy input author",
        );
      }
      const { recorder: source } = await admitPending(fixture);
      const message = source.getPendingInputMessage?.();
      if (!message) {
        throw new Error("Expected the approved original source before collection");
      }
      if (disposition !== "interrupted") {
        const aggregate = createUserTurnTranscriptRecorder({
          input: {
            text: "Collected follow-up already accepted for execution.",
            idempotencyKey: "legacy-collected-follow-up:user",
            timestamp: Date.now(),
          },
          pendingInputSources: [source],
          target: () => ({
            ...fixture.scope,
            sessionEntry: loadSessionEntry(fixture.scope),
            expectedSessionId: fixture.scope.sessionId,
          }),
        });
        await aggregate.persistApproved();
      }
      const transcript = fixture.readTranscript();
      if (disposition !== "interrupted") {
        expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
        expect(await pending(fixture)).toEqual({ items: [], total: 0 });
      }
      if (legacy) {
        rotateAgentEventLifecycleGeneration();
      }
      await fixture.finishDispatch();
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
      if (!legacy) {
        const registry = getTestPluginRegistry();
        registry.typedHooks = registry.typedHooks.filter(
          (hook) => hook.pluginId !== "approved-input-fixture",
        );
        initializeGlobalHookRunner(registry);
      }
      if (legacy) {
        const legacyMessage = structuredClone(message);
        // Legacy receipts predate the admitted request identity.
        delete legacyMessage["__openclaw"]?.chatRequestIdentity;
        delete legacyMessage["__openclaw"]?.requesterOrigin;
        if (!recordedClient) {
          // Shipped Gateway receipts predate transport.clients. Seed only after
          // collection, whose live owner still requires its exact accepted bytes.
          delete legacyMessage["__openclaw"]?.transport;
        }
        const { timestamp: _timestamp, ...stableMessage } = legacyMessage;
        const legacyHash = createHash("sha256")
          .update(stableStringify(stableMessage))
          .digest("hex");
        const database = openOpenClawAgentDatabase(
          toDatabaseOptions(resolveSqliteScope(fixture.scope)),
        );
        const seeded = database.db
          .prepare(
            "UPDATE session_pending_inputs SET request_hash = ?, message_json = ? WHERE session_key = ? AND session_id = ? AND run_id = ?",
          )
          .run(
            legacyHash,
            JSON.stringify(legacyMessage),
            fixture.scope.sessionKey,
            fixture.scope.sessionId,
            fixture.params.idempotencyKey,
          );
        expect(seeded.changes).toBe(1);
        if (disposition === "interrupted") {
          // Old installs may retain these bytes, but ordinary history never revives their custody.
          database.db
            .prepare(
              "UPDATE session_pending_inputs SET state = 'interrupted' WHERE session_key = ? AND session_id = ? AND run_id = ?",
            )
            .run(fixture.scope.sessionKey, fixture.scope.sessionId, fixture.params.idempotencyKey);
        }
      }
      const retained = await readPendingInputSource(
        fixture.scope,
        `${fixture.params.idempotencyKey}:user`,
        true,
      );
      expect(retained?.snapshot.current).toBe(true);
      expect(retained?.snapshot.pending).toBeDefined();
      fixture.context.dedupe.clear();
      dispatchInboundMessageMock.mockClear();
      if (disposition === "changed-payload") {
        fixture.params.message += " Changed request.";
      }

      const retried = await fixture.send();
      if (disposition !== "changed-payload") {
        expect(retried).toHaveBeenCalledWith(
          true,
          {
            runId: fixture.params.idempotencyKey,
            status: "ok",
            ...(disposition === "consumed" ? { messageSeq: 2 } : {}),
          },
          undefined,
          expect.objectContaining({ cached: true }),
        );
      } else {
        expect(retried.mock.calls[0]?.[0]).toBe(false);
      }
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(fixture.readTranscript()).toEqual(transcript);
      expect((await pending(fixture)).total).toBe(0);
      expect(
        (await readPendingInputSource(fixture.scope, `${fixture.params.idempotencyKey}:user`, true))
          ?.snapshot.pending,
      ).toEqual(retained?.snapshot.pending);
    },
  );
}
