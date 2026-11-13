import assert from "node:assert/strict";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { prepareSessionPendingInputDedupeRecovery } from "../../config/sessions/session-accessor.pending-inputs.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx, createRoutedTestCtx } from "./test-ctx.js";

type Recorder = ReturnType<typeof createUserTurnTranscriptRecorder>;
async function cancel(...recorders: (Recorder | undefined)[]) {
  for (const recorder of recorders) {
    recorder?.finishPendingInput?.("cancelled");
  }
  for (const recorder of recorders) {
    await recorder?.waitForPendingInputSettlement?.();
  }
}
async function seedSource(
  target: Omit<UserTurnTranscriptTarget, "sessionEntry">,
  runId: string,
  text: string,
  timestamp?: number,
) {
  const sessionEntry = { sessionId: target.sessionId, updatedAt: Date.now() };
  await replaceSessionEntry(target, sessionEntry);
  return () =>
    createUserTurnTranscriptRecorder({
      target: { ...target, sessionEntry },
      pendingInputRequestFingerprint: `${runId}-request`,
      input: { text, timestamp, idempotencyKey: `${runId}:user` },
    });
}

it("dispatches an explicitly retried input despite its prior inbound dedupe receipt", async () => {
  await withOpenClawTestState({ label: "pending-input-live-retry" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {} },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const sessionKey = "agent:main:pending-restart";
    const sessionId = "pending-restart-session";
    const runId = "pending-restart-input";
    const target = { agentId: "main", sessionKey, sessionId, config: cfg };
    const message = "Deliver this exact source after the update";
    const createRecorder = await seedSource(target, runId, message, 100);
    const source = createRecorder();
    const ctx = createRoutedTestCtx("webchat", sessionKey, {
      AgentId: "main",
      From: "gateway-owner",
      SessionKey: sessionKey,
      MessageSid: runId,
      Body: message,
      BodyForAgent: message,
      CommandBody: message,
      CommandSource: undefined,
      CommandAuthorized: true,
    });
    resetInboundDedupe();
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    let resumed: ReturnType<typeof createRecorder> | undefined;
    try {
      expect(await source.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
      const original = (await listSessionPendingInputs(target)).items[0];
      expect(original).toBeDefined();
      const claim = claimInboundDedupe(ctx);
      assert(claim.status === "claimed", "Original input did not acquire inbound dedupe");
      claim.commit();
      await cancel(source);
      resumed = createRecorder();
      expect(
        await resumed.stageApproved?.({ runId, retryCancelled: true, assertCurrent: () => {} }),
      ).toBe(true);
      expect((await listSessionPendingInputs(target)).items).toEqual([
        { ...original, state: "queued" },
      ]);
      expect(claimInboundDedupe(ctx).status).toBe("duplicate");

      const recorder = resumed;
      const replyResolver = vi.fn(async () => {
        expect(claimInboundDedupe(ctx).status).toBe("inflight");
        await recorder.persistApproved();
        return { text: "Input delivered" };
      });
      await recorder.withPendingInput?.(() =>
        dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher,
          replyOptions: { userTurnTranscriptRecorder: recorder },
          replyResolver,
        }),
      );
      expect(replyResolver).toHaveBeenCalledOnce();
      expect((await listSessionPendingInputs(target)).items).toEqual([]);
      const transcript = await loadTranscriptEvents(target);
      const userMessages = transcript.filter((event) => {
        const record = asOptionalRecord(event);
        return record?.type === "message" && asOptionalRecord(record.message)?.role === "user";
      });
      expect(userMessages).toMatchObject([
        { message: { content: message, idempotencyKey: `${runId}:user` } },
      ]);
    } finally {
      await cancel(resumed, source);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      resetInboundDedupe();
    }
  });
});

it.each([
  "initial",
  "inflight",
  "cache-miss",
  "consumed",
  "session",
  "input",
  "revoked",
  "revoked-after-read",
] as const)(
  "keeps completed inbound receipts bound to one exact live retry source (%s)",
  async (control) => {
    await withOpenClawTestState({ label: "pending-input-dedupe-controls" }, async () => {
      setRuntimeConfigSnapshot({});
      onTestFinished(() => clearRuntimeConfigSnapshot());
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dedupe",
        sessionId: "dedupe-session",
      };
      const runId = "dedupe-source";
      let current = true;
      const createRecorder = await seedSource(target, runId, "Keep this exact input");
      const assertCurrent = () => {
        if (!current) {
          throw new Error("source revoked");
        }
      };
      const original = createRecorder();
      let recorder = original;
      const ctx = buildTestCtx({
        Provider: "webchat",
        SessionKey: target.sessionKey,
        MessageSid: runId,
      });
      resetInboundDedupe();
      let restoreClock: (() => void) | undefined;
      try {
        expect(await original.stageApproved?.({ runId, assertCurrent })).toBe(true);
        const first = claimInboundDedupe(ctx);
        assert(first.status === "claimed", "Original input did not acquire inbound dedupe");
        first.commit();
        if (control !== "initial") {
          await cancel(original);
          recorder = createRecorder();
          expect(
            await recorder.stageApproved?.({ runId, retryCancelled: true, assertCurrent }),
          ).toBe(true);
        }
        const claim = async (scope = target, sourceRunId = runId) =>
          claimInboundDedupe(ctx, {
            reclaimPendingInput: await prepareSessionPendingInputDedupeRecovery(scope, sourceRunId),
          });
        let activeClaim: ReturnType<typeof claimInboundDedupe> | undefined;
        if (control === "consumed") {
          await recorder.withPendingInput?.(() => recorder.persistApproved());
        } else if (control === "cache-miss") {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * 60_000 + 1);
          restoreClock = () => clock.mockRestore();
        } else if (control === "inflight") {
          first.release();
          activeClaim = claimInboundDedupe(ctx);
          expect(activeClaim.status).toBe("claimed");
        }
        let result: ReturnType<typeof claimInboundDedupe> | undefined;
        if (control === "revoked-after-read") {
          await recorder.withPendingInput?.(async () => {
            const reclaimPendingInput = await prepareSessionPendingInputDedupeRecovery(
              target,
              runId,
            );
            current = false;
            expect(() => claimInboundDedupe(ctx, { reclaimPendingInput })).toThrow(
              "source revoked",
            );
          });
          current = true;
        } else if (control === "revoked") {
          await expect(async () =>
            recorder.withPendingInput?.(() => {
              current = false;
              return claim();
            }),
          ).rejects.toThrow("source revoked");
          current = true;
        } else {
          result = await recorder.withPendingInput?.(() =>
            claim(
              control === "session" ? { ...target, sessionId: "replacement-session" } : target,
              control === "input" ? "another-source" : runId,
            ),
          );
          expect(result?.status).toBe(
            control === "cache-miss"
              ? "claimed"
              : control === "inflight"
                ? "inflight"
                : "duplicate",
          );
        }
        if (control === "initial" || control === "consumed") {
          expect(claimInboundDedupe(ctx).status).toBe("duplicate");
          return;
        }
        activeClaim?.release?.();
        const recovered =
          control === "cache-miss" ? result : await recorder.withPendingInput?.(() => claim());
        assert(recovered?.status === "claimed", "Retried input did not acquire inbound dedupe");
        recovered.commit();
        // Old finalizers cannot erase or recommit the replacement's receipt.
        first.release();
        first.commit();
        expect((await recorder.withPendingInput?.(() => claim()))?.status).toBe("duplicate");
      } finally {
        restoreClock?.();
        resetInboundDedupe();
        current = true;
        await cancel(recorder, original);
      }
    });
  },
);
