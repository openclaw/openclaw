import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice } from "../infra/update-run-notice.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUpdateRunNotifier } from "./update-run-notice.runtime.js";

describe("host-owned update notices", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-update-notice-" });
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each(["succeeded", "failed"] as const)(
    "keeps %s notices concise and saves diagnostic details",
    async (status) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const advice =
        "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds.";
      const warning = "gateway.auth.token is SecretRef-managed; verify the daemon runtime context.";
      const initial = createUpdateRun({
        trigger: "chat",
        origin: { sessionKey: target.sessionKey, nextAction: advice },
      });
      recordUpdateRunStep(initial.runId, {
        step: "warning:gateway-auth",
        status: "completed",
        detail: warning,
      });
      recordUpdateRunVerification(initial.runId, { port: 19123, versionMatch: false });
      const finished = finishUpdateRun(initial.runId, {
        status,
        ...(status === "failed" ? { reason: "restart-unhealthy" } : {}),
      });
      if (!finished) {
        throw new Error("Missing finished update");
      }

      const notify = await createUpdateRunNotifier(initial, () => ({}), {});
      expect(await notify(finished, "finished")).toEqual({
        delivered: true,
        owned: true,
      });

      const messages = (await loadTranscriptEvents(target)).filter(
        (event) => asOptionalRecord(event)?.type === "message",
      );
      const headline =
        status === "failed" ? "⚠️ OpenClaw couldn't finish updating." : "✅ OpenClaw updated.";
      expect(messages).toMatchObject([
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `${headline}\nFor details, open Settings → Updates in the Control UI or run \`openclaw update status\` in your terminal.`,
              },
            ],
          },
        },
      ]);
      expect(getUpdateRun(initial.runId)).toMatchObject({
        status,
        origin: { nextAction: advice },
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "warning:gateway-auth", detail: warning }),
        ]),
        verification: { port: 19123, versionMatch: false, noticeDelivered: true },
      });
    },
  );

  it.each([false, true])(
    "outlives the requesting attempt while honoring session replacement (%s)",
    async (replaced) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "admitted-session",
        updatedAt: 1,
      });
      const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
      const notify = await createUpdateRunNotifier(run, () => ({}), {});
      if (replaced) {
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "replacement-session",
          updatedAt: 2,
        });
      }
      const result = await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          withTranscriptWrite: async () => {
            throw new Error("attempt disposed before transcript write");
          },
        },
        () => notify(run, "parking"),
      );
      expect(result).toEqual({ delivered: !replaced, owned: !replaced });
      const events = await loadTranscriptEvents(target);
      const messages = events.filter((event) => asOptionalRecord(event)?.type === "message");
      expect(messages).toHaveLength(replaced ? 0 : 1);
      if (!replaced) {
        expect(messages[0]).toMatchObject({
          message: {
            role: "assistant",
            content: [{ type: "text", text: renderUpdateRunNotice(run, "parking") }],
          },
        });
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
      }
      expect(getUpdateRun(run.runId)?.phase).toBe("requested");
    },
  );
});
