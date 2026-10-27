import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUpdateRunNotifier } from "./update-run-notice.runtime.js";

describe("host-owned update notices", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-update-notice-" });
    await captureRuntimeConfigAsyncReader()();
  });
  afterEach(() => state.cleanup());
  const target = () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "update-session",
    storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
  });
  const messages = async () =>
    (await loadTranscriptEvents(target())).filter(
      (event) => asOptionalRecord(event)?.type === "message",
    );
  const assistantMessage = (text: string) => ({
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const seedSession = (lifecycleRevision?: string, updatedAt = 1) =>
    upsertSessionEntryCore(target(), {
      sessionId: target().sessionId,
      updatedAt,
      lifecycleRevision,
    });

  it.each(["succeeded", "failed"] as const)(
    "keeps %s notices concise and saves diagnostic details",
    async (status) => {
      await seedSession();
      const advice =
        "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds.";
      const warning = "gateway.auth.token is SecretRef-managed; verify the daemon runtime context.";
      const initial = createUpdateRun({
        trigger: "chat",
        origin: { sessionKey: target().sessionKey, nextAction: advice },
      });
      recordUpdateRunStep(initial.runId, {
        step: "warning:gateway-auth",
        status: "completed",
        detail: warning,
      });
      recordUpdateRunVerification(initial.runId, { port: 19123, versionMatch: false });
      const finished = expectDefined(
        finishUpdateRun(initial.runId, {
          status,
          ...(status === "failed" ? { reason: "restart-unhealthy" } : {}),
        }),
        "finished update",
      );

      const notify = await createUpdateRunNotifier(initial, () => ({}), {});
      expect(await notify(finished, "finished")).toEqual({ delivered: true, owned: true });
      const headline =
        status === "failed" ? "⚠️ OpenClaw couldn't finish updating." : "✅ OpenClaw updated.";
      expect(await messages()).toMatchObject([
        assistantMessage(
          `${headline}\nFor details, open Settings → Updates in the Control UI or run \`openclaw update status\` in your terminal.`,
        ),
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
    "delivers after attempt disposal unless the session was replaced (%s)",
    async (replaced) => {
      await seedSession("admitted-session");
      const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target().sessionKey } });
      const notify = await createUpdateRunNotifier(run, () => ({}), {});
      if (replaced) {
        await seedSession("replacement-session", 2);
      }
      const result = await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target(),
          withTranscriptWrite: async () => {
            throw new Error("attempt disposed before transcript write");
          },
        },
        () => notify(run, "parking"),
      );
      expect(result).toEqual({ delivered: !replaced, owned: !replaced });
      expect(await messages()).toMatchObject(
        replaced ? [] : [assistantMessage("⏳ Restarting OpenClaw…")],
      );
      if (!replaced) {
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
      }
      expect(getUpdateRun(run.runId)?.phase).toBe("requested");
    },
  );

  it("records a targetless milestone once across notifier recreation", async () => {
    const initial = createUpdateRun({ trigger: "cli" });
    const run = recordUpdateRunPhase(initial.runId, "verifying");
    const notify = await createUpdateRunNotifier(run, () => ({}), {});
    expect(await notify(run, "verifying")).toEqual({ delivered: false, owned: false });
    const skipped = expectDefined(getUpdateRun(run.runId), "skipped notice");
    expect(skipped.steps).toContainEqual(
      expect.objectContaining({ step: "notice:verifying", status: "skipped" }),
    );
    expect(skipped.verification.noticeDelivered).toBe(false);
    const recovered = await createUpdateRunNotifier(skipped, () => ({}), {});
    expect(await recovered(skipped, "verifying")).toEqual({ delivered: false, owned: false });
    expect(getUpdateRun(run.runId)).toEqual(skipped);
  });

  it.each([true, false])(
    "reconciles only a previously admitted terminal completion (%s)",
    async (terminal) => {
      await seedSession();
      const initial = createUpdateRun({
        trigger: "chat",
        origin: { sessionKey: target().sessionKey },
      });
      const finished = expectDefined(
        finishUpdateRun(initial.runId, { status: "succeeded" }),
        "finished update",
      );
      const previousText = terminal
        ? "⚠️ OpenClaw couldn't finish updating.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal."
        : "🔁 Checking that OpenClaw is ready…";
      expect(
        await appendAssistantMessageToSessionTranscript({
          ...target(),
          expectedSessionId: target().sessionId,
          text: previousText,
          idempotencyKey: `update-run-finished:${initial.runId}`,
        }),
      ).toMatchObject({ ok: true });
      const notify = await createUpdateRunNotifier(initial, () => ({}), {});
      expect(await notify(finished, "finished")).toEqual({ delivered: terminal, owned: terminal });
      expect(getUpdateRun(initial.runId)?.verification.noticeDelivered === true).toBe(terminal);
      expect(await messages()).toMatchObject([assistantMessage(previousText)]);
    },
  );
});
