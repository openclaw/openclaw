import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginSessionEffect,
  getSessionMutationCount,
} from "../../sessions/session-controller.lifecycle.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { requestActiveCronJobCancellation } from "../active-jobs.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronServiceDeps } from "../service/state.js";
import {
  withCompletionFixture,
  installCompletionChannel,
  expectDeliveryWarning,
  PNG,
} from "./current-session-completion.test-fixtures.js";
import * as deliveryPolicy from "./delivery-dispatch-policy.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

it.each(["literal-text", "prepared-media"] as const)(
  "preserves %s output when committing the conversation",
  (mode) =>
    withCompletionFixture(async (fixture) => {
      const { params } = fixture;
      const hasMedia = mode === "prepared-media";
      const text = hasMedia ? undefined : "NO_REPLY";
      params.deliveryPayloads = [
        { text, ...(hasMedia ? { mediaUrl: fixture.payload.mediaUrl } : {}) },
      ];
      Object.assign(params, { synthesizedText: text, outputText: text, summary: text });

      await expect(dispatchCronDelivery(params)).resolves.toMatchObject({ delivered: true });
      const messages = await fixture.messages();
      expect(messages).toHaveLength(1);
      const message = readTranscriptEventMessage(messages[0]);
      expect(message?.content).toEqual([
        { type: "text", text: hasMedia ? "report.png" : "NO_REPLY" },
      ]);
      if (hasMedia) {
        expect(readAssistantDisplayContent(message)).toMatchObject([{ type: "image" }]);
        expect(await fixture.records()).toHaveLength(1);
      }
    }),
);

it("does not write a report into the creator when explicit account intent is unresolved", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    params.job.delivery = { mode: "announce", accountId: "work" };
    params.deliveryPlan = resolveCronDeliveryPlan(params.job);
    params.deliveryPayloads = [{ text: "Final report" }];
    await expect(dispatchCronDelivery(params)).resolves.toMatchObject({
      delivered: false,
      deliveryError: "No external channel",
      disposition: { kind: "error", errorKind: "delivery-target" },
    });
    expect(await fixture.messages()).toEqual([]);
  }));
it.each([
  { stage: "commit", revoke: "cancel" },
  { stage: "commit", revoke: "owner" },
  { stage: "send", revoke: "cancel" },
  { stage: "send", revoke: "owner" },
] as const)("honors the real occurrence fence after $revoke before $stage", ({ stage, revoke }) =>
  withCompletionFixture(
    async (fixture, state) => {
      const { params } = fixture;
      params.cfgWithAgentDefaults.session = {
        ...params.cfgWithAgentDefaults.session,
        dmScope: "per-channel-peer",
      };
      const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "forbidden" }));
      const sendMedia = vi.fn(async () => ({ channel: "telegram", messageId: "media" }));
      installCompletionChannel("telegram", { deliveryMode: "direct", sendText, sendMedia });
      let available = true;
      let revoked = false;
      const revokeOccurrence = () => {
        revoked = true;
        if (revoke === "cancel") {
          requestActiveCronJobCancellation(params.job.id, "test occurrence cancelled");
        } else {
          available = false;
        }
      };
      const admission = probe.admission(operationAdmission, (request, grant, admit) => {
        if (
          stage === "commit" &&
          request.stage === "commit" &&
          isRecord(request.facts) &&
          request.facts.type === "managedImages.insert"
        ) {
          expect(sendMedia).toHaveBeenCalledOnce();
          revokeOccurrence();
        }
        admit(request, grant);
      });
      const tts = vi
        .spyOn(deliveryPolicy, "maybeApplyTtsToCronPayloads")
        .mockImplementation(async ({ payloads }) => {
          if (stage === "send") {
            expect(await fixture.messages()).toHaveLength(0);
            revokeOccurrence();
          }
          return payloads;
        });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(
        async ({ job, abortSignal, deliveryAttemptFence }) => {
          expect(deliveryAttemptFence).not.toBeNull();
          params.job = job;
          params.deliveryPlan = resolveCronDeliveryPlan(job);
          params.deliveryAttemptFence = deliveryAttemptFence;
          params.abortSignal = abortSignal;
          params.isAborted = () => abortSignal?.aborted === true;
          params.runStartedAt = Date.now();
          params.resolvedDelivery = await resolveDeliveryTarget(
            params.cfgWithAgentDefaults,
            "main",
            { ...job, ...params.deliveryPlan },
          );
          const result = await dispatchCronDelivery(params);
          expect(result.delivered).toBe(stage === "commit");
          if (stage === "commit") {
            expectDeliveryWarning(
              result,
              expect.stringContaining(
                "result was delivered but was not added to the conversation:",
              ),
            );
          }
          return {
            status: result.delivered ? "ok" : "error",
            error: result.deliveryError,
          };
        },
      );
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath: state.path("cron", "jobs.json"),
        cronEnabled: false,
        defaultAgentId: "main",
        isAgentAvailable: () => available,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob,
      });
      try {
        await state.writeConfig(params.cfgWithAgentDefaults);
        await cron.start();
        const job = await cron.add({
          name: "fenced result",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "current",
          sessionKey: fixture.scope.sessionKey,
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "produce a result" },
          delivery: { mode: "announce", channel: "telegram", to: "12345" },
        });
        await cron.run(job.id, "force");
        // Cancellation can finish cron.run before the callback finishes media cleanup.
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
        await runIsolatedAgentJob.mock.results[0]!.value;
        expect(revoked).toBe(true);
        expect(sendMedia).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
        expect(await fixture.messages()).toHaveLength(0);
        if (stage === "commit") {
          // File deletion is best effort; a durable cleanup claim must stay unservable.
          const entries = await fixture.records();
          expect(entries.length).toBeLessThanOrEqual(1);
          for (const entry of entries) {
            expect(entry).toMatchObject({
              cleanupPending: true,
              record: {
                sessionKey: fixture.scope.sessionKey,
                retentionClass: "transient",
                messageId: null,
                alt: "report.png",
              },
            });
            expect(await fixture.downloadAttachment(entry.record.attachmentId)).toBeNull();
          }
        }
      } finally {
        cron.stop();
        await Promise.allSettled(runIsolatedAgentJob.mock.results.map(({ value }) => value));
        admission.mockRestore();
        tts.mockRestore();
      }
    },
    "current",
    "agent:main:telegram:direct:12345",
  ),
);

it("publishes downloadable media and replays the original message after promotion failure", () =>
  withCompletionFixture(async (fixture) => {
    using admission = probe.admission(operationAdmission, (request, grant, admit) => {
      if (
        request.stage === "commit" &&
        isRecord(request.facts) &&
        request.facts.type === "managedImages.attach"
      ) {
        throw new Error("report promotion failed");
      }
      admit(request, grant);
    });
    await expect(fixture.commit()).rejects.toThrow("report promotion failed");
    expect(fixture.updates()).toBe(0);
    admission.mockRestore();
    const original = await fixture.messages();
    const originalIds = (await fixture.records()).map(({ record }) => record.attachmentId);
    expect(original).toHaveLength(1);
    await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
    expect(await fixture.messages()).toEqual(original);
    expect((await fixture.records()).map(({ record }) => record.attachmentId)).toEqual(originalIds);
    expect(fixture.updates()).toBeGreaterThan(0);
    for (const { record } of await fixture.records()) {
      expect(record).toMatchObject({
        messageId: readTranscriptEventId(original[0]),
        retentionClass: "history",
      });
      const { mediaRoot, mediaSubdir, mediaId } = record.original;
      await expect(fs.readFile(path.join(mediaRoot, mediaSubdir, mediaId))).resolves.toEqual(PNG);
    }
    const downloads = await fixture.downloads();
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.map((download) => download?.type)).toEqual(downloads.map(() => "image"));
  }));

it("preserves interleaved report text, media, and spoken-payload failure metadata", () =>
  withCompletionFixture(async (fixture, state) => {
    const secondImage = path.join(state.workspaceDir, "second.png");
    await fs.writeFile(secondImage, PNG);
    fixture.params.deliveryPayloads.push(
      setReplyPayloadMetadata(
        {
          spokenText: "Second report",
          mediaUrl: secondImage,
        },
        {
          assistantMediaFailures: [{ code: "file-not-found", kind: "image", label: "missing.png" }],
        },
      ),
    );
    await fixture.commit();
    const message = readTranscriptEventMessage((await fixture.messages())[0]);
    expect(readAssistantDisplayContent(message)).toEqual([
      { type: "text", text: "Example report" },
      expect.objectContaining({ type: "image", alt: "report.png" }),
      { type: "text", text: "Second report" },
      expect.objectContaining({ type: "image", alt: "second.png" }),
      expect.objectContaining({
        type: "attachment_error",
        attachment: expect.objectContaining({ label: "missing.png" }),
      }),
    ]);
  }));

it("blocks workspace-only images beside the session store", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    const privateImage = path.join(path.dirname(fixture.scope.storePath), "private.png");
    await fs.mkdir(path.dirname(privateImage), { recursive: true });
    await fs.writeFile(privateImage, PNG);
    params.cfgWithAgentDefaults.tools = { profile: "full", fs: { workspaceOnly: true } };
    params.deliveryPayloads = [{ text: "Report", mediaUrl: privateImage }];
    await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
    const message = readTranscriptEventMessage((await fixture.messages())[0]);
    expect(readAssistantDisplayContent(message)).toEqual([
      { type: "text", text: "Report" },
      expect.objectContaining({ type: "attachment_error" }),
    ]);
    expect(await fixture.records()).toHaveLength(0);
  }));

it("does not prepare media when the source generation changes while waiting", () =>
  withCompletionFixture(async (fixture) => {
    const admission = await beginSessionEffect({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      assertAllowed: () => {},
    });
    const commit = fixture.commit();
    try {
      await vi.waitFor(() => expect(getSessionMutationCount()).toBe(1));
      expect(await fixture.records()).toEqual([]);
      await replaceSessionEntry(fixture.scope, {
        sessionId: "replacement-session",
        lifecycleRevision: "replacement-generation",
        updatedAt: 3000,
      });
      admission.release();
      await expect(commit).resolves.toMatchObject({ ok: false });
      expect(await fixture.records()).toEqual([]);
      expect(await fixture.messages()).toEqual([]);
      expect(fixture.updates()).toBe(0);
    } finally {
      admission.release();
      await commit;
    }
  }));
