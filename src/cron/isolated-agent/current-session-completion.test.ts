import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
} from "../../sessions/session-lifecycle-admission.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { requestActiveCronJobCancellation } from "../active-jobs.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import { createCompletionFixture, PNG } from "./current-session-completion.test-fixtures.js";
import * as deliveryPolicy from "./delivery-dispatch-policy.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

describe("current-session completion delivery", () => {
  it.each(["leading-token", "silent-media-caption"] as const)(
    "normalizes %s output before committing the conversation",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          const hasMedia = mode === "silent-media-caption";
          const text = hasMedia ? "Report complete.\nNO_REPLY" : "NO_REPLY\nReport complete.";
          fixture.params.deliveryPayloads = [
            { text, ...(hasMedia ? { mediaUrl: fixture.payload.mediaUrl } : {}) },
          ];
          fixture.params.synthesizedText = text;
          fixture.params.outputText = text;
          fixture.params.summary = text;

          const delivery = await dispatchCronDelivery(fixture.params);
          expect(delivery.delivered).toBe(true);
          const messages = await fixture.messages();
          expect(messages).toHaveLength(1);
          const message = readTranscriptEventMessage(messages[0]);
          expect(message?.content).toEqual([
            { type: "text", text: hasMedia ? "report.png" : "Report complete." },
          ]);
          if (hasMedia) {
            expect(readAssistantDisplayContent(message)).toEqual([
              expect.objectContaining({ type: "image" }),
            ]);
            expect(await fixture.records()).toHaveLength(1);
          }
        } finally {
          await fixture.dispose();
        }
      });
    },
  );

  it.each([{ to: "recipient" }, { accountId: "work" }, { threadId: 0 }])(
    "does not write a report into the creator when explicit intent is unresolved %j",
    async (coordinates) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          fixture.params.job.delivery = { mode: "announce", ...coordinates };
          fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.params.job);
          fixture.params.deliveryPayloads = [{ text: "Final report" }];
          const completion = await dispatchCronDelivery(fixture.params);
          const messages = await fixture.messages();
          expect(messages).toEqual([]);
          expect(completion).toMatchObject({
            delivered: false,
            deliveryError: "No external channel",
            disposition: { kind: "error", errorKind: "delivery-target" },
          });
        } finally {
          await fixture.dispose();
        }
      });
    },
  );
});

describe("current-session completion media", () => {
  it.each([
    { stage: "commit", revoke: "cancel" },
    { stage: "commit", revoke: "owner" },
    { stage: "send", revoke: "cancel" },
    { stage: "send", revoke: "owner" },
  ] as const)(
    "honors the real occurrence fence after $revoke before $stage",
    async ({ stage, revoke }) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(
          state,
          "current",
          "agent:main:telegram:direct:12345",
        );
        fixture.params.cfgWithAgentDefaults.session = {
          ...fixture.params.cfgWithAgentDefaults.session,
          dmScope: "per-channel-peer",
        };
        const registry = captureActivePluginRegistrySnapshot();
        const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "forbidden" }));
        const sendMedia = vi.fn(async () => ({ channel: "telegram", messageId: "media" }));
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: { deliveryMode: "direct", sendText, sendMedia },
              },
            },
          ]),
        );
        let available = true;
        let revoked = false;
        const revokeOccurrence = () => {
          revoked = true;
          if (revoke === "cancel") {
            requestActiveCronJobCancellation(fixture.params.job.id, "test occurrence cancelled");
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
        const cron = new CronService({
          scheduler: createTestGatewayScheduler(),
          storePath: state.path("cron", "jobs.json"),
          cronEnabled: false,
          defaultAgentId: "main",
          isAgentAvailable: () => available,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: async ({ job, abortSignal, deliveryAttemptFence }) => {
            expect(deliveryAttemptFence).not.toBeNull();
            fixture.params.job = job;
            fixture.params.deliveryPlan = resolveCronDeliveryPlan(job);
            fixture.params.deliveryAttemptFence = deliveryAttemptFence;
            fixture.params.abortSignal = abortSignal;
            fixture.params.isAborted = () => abortSignal?.aborted === true;
            fixture.params.runStartedAt = Date.now();
            fixture.params.resolvedDelivery = await resolveDeliveryTarget(
              fixture.params.cfgWithAgentDefaults,
              "main",
              { ...job, ...fixture.params.deliveryPlan },
            );
            const result = await dispatchCronDelivery(fixture.params);
            expect(result.delivered).toBe(stage === "commit");
            if (stage === "commit") {
              expect(result).toMatchObject({
                deliveryError: undefined,
                diagnostics: {
                  entries: expect.arrayContaining([
                    expect.objectContaining({
                      source: "delivery",
                      severity: "warn",
                      message: expect.stringContaining(
                        "result was delivered but was not added to the conversation:",
                      ),
                    }),
                  ]),
                },
              });
            }
            return {
              status: result.delivered ? "ok" : "error",
              error: result.deliveryError,
            };
          },
        });
        try {
          await state.writeConfig(fixture.params.cfgWithAgentDefaults);
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
          expect(revoked).toBe(true);
          expect(sendMedia).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
          expect(await fixture.messages()).toHaveLength(0);
          if (stage === "commit") {
            expect(await fixture.records()).toEqual([]);
          }
        } finally {
          cron.stop();
          admission.mockRestore();
          tts.mockRestore();
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.dispose();
        }
      });
    },
  );

  it.each(["ordinary", "promotion-failure"] as const)(
    "publishes downloadable media and replays the original message after %s",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        let restorePromotionAdmission: (() => void) | undefined;
        try {
          if (mode === "promotion-failure") {
            const spy = probe.admission(operationAdmission, (request, grant, admit) => {
              if (
                request.stage === "commit" &&
                isRecord(request.facts) &&
                request.facts.type === "managedImages.attach"
              ) {
                throw new Error("report promotion failed");
              }
              admit(request, grant);
            });
            restorePromotionAdmission = () => spy.mockRestore();
            await expect(fixture.commit()).rejects.toThrow("report promotion failed");
            expect(fixture.updates()).toBe(0);
            restorePromotionAdmission();
          } else {
            await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          }
          const original = await fixture.messages();
          const originalIds = (await fixture.records()).map(({ record }) => record.attachmentId);
          expect(original).toHaveLength(1);
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          expect(await fixture.messages()).toEqual(original);
          expect((await fixture.records()).map(({ record }) => record.attachmentId)).toEqual(
            originalIds,
          );
          expect(fixture.updates()).toBeGreaterThan(0);
          for (const { record } of await fixture.records()) {
            expect(record).toMatchObject({
              messageId: readTranscriptEventId(original[0]),
              retentionClass: "history",
            });
            await expect(
              fs.readFile(
                path.join(
                  record.original.mediaRoot,
                  record.original.mediaSubdir,
                  record.original.mediaId,
                ),
              ),
            ).resolves.toEqual(PNG);
          }
          const downloads = await fixture.downloads();
          expect(downloads.length).toBeGreaterThan(0);
          for (const download of downloads) {
            expect(download).toMatchObject({ type: "image" });
          }
        } finally {
          restorePromotionAdmission?.();
          await fixture.dispose();
        }
      });
    },
  );

  it("keeps structured report text in both model and display history", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      try {
        fixture.payload.presentation = {
          blocks: [
            {
              type: "table",
              caption: "Revenue",
              headers: ["Quarter", "Revenue"],
              rows: [["Q1", 10]],
            },
          ],
        };
        await fixture.commit();
        const message = readTranscriptEventMessage((await fixture.messages())[0]);
        expect(message?.content).toEqual([
          {
            type: "text",
            text: "Example report\nRevenue (table)\n- Quarter: Q1; Revenue: 10\nreport.png",
          },
        ]);
        expect(readAssistantDisplayContent(message)).toEqual([
          { type: "text", text: "Example report\nRevenue (table)\n- Quarter: Q1; Revenue: 10" },
          expect.objectContaining({ type: "image" }),
        ]);
      } finally {
        await fixture.dispose();
      }
    });
  });

  it.each(["text-only", "missing-image", "media-only"] as const)(
    "preserves the completed result for %s output",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          if (mode === "text-only") {
            fixture.params.deliveryPayloads = [{ text: "Final report" }];
          } else if (mode === "missing-image") {
            await fs.unlink(path.join(state.workspaceDir, "report.png"));
          } else {
            fixture.payload.text = undefined;
          }
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          const message = readTranscriptEventMessage((await fixture.messages())[0]);
          if (mode === "media-only") {
            expect(readAssistantDisplayContent(message)).toEqual([
              expect.objectContaining({ type: "image" }),
            ]);
            expect(await fixture.records()).toHaveLength(1);
          } else {
            expect(message?.content).toEqual([
              {
                type: "text",
                text: mode === "text-only" ? "Final report" : "Example report\nreport.png",
              },
            ]);
            if (mode === "missing-image") {
              expect(readAssistantDisplayContent(message)).toEqual([
                { type: "text", text: "Example report" },
                expect.objectContaining({
                  type: "attachment_error",
                  attachment: expect.objectContaining({
                    label: "report.png",
                    code: "delivery-failed",
                  }),
                }),
              ]);
            } else {
              expect(message).not.toHaveProperty("openclawDisplayContent");
            }
            expect(await fixture.records()).toEqual([]);
          }
        } finally {
          await fixture.dispose();
        }
      });
    },
  );

  it("preserves interleaved report text, media, and spoken-payload failure metadata", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      try {
        const secondImage = path.join(state.workspaceDir, "second.png");
        await fs.writeFile(secondImage, PNG);
        fixture.params.deliveryPayloads.push(
          setReplyPayloadMetadata(
            {
              spokenText: "Second report",
              mediaUrl: secondImage,
            },
            {
              assistantMediaFailures: [
                { code: "file-not-found", kind: "image", label: "missing.png" },
              ],
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
      } finally {
        await fixture.dispose();
      }
    });
  });

  it.each([true, false])(
    "obeys workspaceOnly=%s for images beside the session store",
    async (workspaceOnly) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state);
        try {
          const privateImage = path.join(path.dirname(fixture.scope.storePath), "private.png");
          await fs.mkdir(path.dirname(privateImage), { recursive: true });
          await fs.writeFile(privateImage, PNG);
          fixture.params.cfgWithAgentDefaults.tools = { profile: "full", fs: { workspaceOnly } };
          fixture.params.deliveryPayloads = [{ text: "Report", mediaUrl: privateImage }];
          await expect(fixture.commit()).resolves.toMatchObject({ ok: true });
          const message = readTranscriptEventMessage((await fixture.messages())[0]);
          const content = readAssistantDisplayContent(message);
          expect(content).toEqual([
            { type: "text", text: "Report" },
            expect.objectContaining({ type: workspaceOnly ? "attachment_error" : "image" }),
          ]);
          expect(await fixture.records()).toHaveLength(workspaceOnly ? 0 : 1);
        } finally {
          await fixture.dispose();
        }
      });
    },
  );

  it("does not prepare media when the source generation changes while waiting", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state);
      const admission = await beginSessionWorkAdmission({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
        assertAllowed: () => {},
      });
      const commit = fixture.commit();
      try {
        await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBe(1));
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
        await fixture.dispose();
      }
    });
  });
});
