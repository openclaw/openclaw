import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as entryReader from "../../config/sessions/session-entry-read-runtime.js";
import * as transcript from "../../config/sessions/transcript.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as sessionDelivery from "../../infra/session-delivery-queue-storage.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  hasPendingGeneratedMediaTaskForSessionKey,
  listMediaGenerationOperations,
} from "../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
import {
  imageGenerationTaskLifecycle,
  runMediaGenerationTask,
} from "./media-generate-background.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

describe("undelivered generated media", () => {
  it.each(["current", "replaced", "rotated", "deleted", "retired-during-append"] as const)(
    "retains references only in the original live requester: %s",
    async (requesterState) => {
      await withOpenClawTestState({ prefix: "media-completion-retention-" }, async (state) => {
        const sessionKey = "agent:main:media-retention";
        const sessionId = "original-media-requester";
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        });
        const scope = { agentId: "main", sessionKey, storePath };
        await replaceSessionEntry(scope, {
          sessionId,
          lifecycleRevision: "original-lifecycle",
          updatedAt: Date.now(),
        });
        vi.useFakeTimers({ toFake: ["Date"] });
        const enqueue = vi
          .spyOn(sessionDelivery, "enqueueClaimedSessionDelivery")
          .mockImplementation(async () => {
            vi.setSystemTime(Date.now() + 120_001);
            throw new Error("synthetic queue admission refused");
          });
        const append = transcript.appendAssistantMessageToSessionTranscript;
        const appendSpy = vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript");
        if (requesterState === "retired-during-append") {
          appendSpy.mockImplementationOnce(async (params) => {
            await Promise.resolve();
            rotateAgentEventLifecycleGeneration();
            return append(params);
          });
        }
        const lifecycle = createMediaGenerationTaskLifecycle({
          toolName: "image_generate",
          taskKind: "image_generation",
          label: "Image generation",
          queuedProgressSummary: "Queued image generation",
          generatedLabel: "image",
          failureProgressSummary: "Image generation failed",
          eventSource: "image_generation",
          announceType: "image generation task",
          completionLabel: "image",
        });
        if (requesterState === "current") {
          await cleanupSessionStateForTest({ stateDir: state.stateDir });
        }
        const creationSql = requesterState === "current" ? observeMainThreadSql() : undefined;
        let handle;
        try {
          handle = await lifecycle.createTaskRun({
            sessionKey,
            requesterAgentId: "main",
            prompt: "a synthetic lighthouse",
            requesterOrigin: { channel: "webchat" },
          });
          creationSql?.expectIdle();
        } finally {
          creationSql?.restore();
        }
        expect(handle).not.toBeNull();
        const scheduled: Array<() => Promise<void>> = [];
        const mediaPath = state.statePath("media", "synthetic-lighthouse.png");
        scheduleMediaGenerationTaskCompletion({
          lifecycle,
          handle,
          scheduleBackgroundWork: (work) => scheduled.push(work),
          progressSummary: "Generating image",
          toolName: "image_generate",
          onWakeFailure: vi.fn(),
          run: async () => {
            if (requesterState === "replaced" || requesterState === "rotated") {
              await replaceSessionEntry(scope, {
                sessionId: requesterState === "replaced" ? "replacement-requester" : sessionId,
                lifecycleRevision: "replacement-lifecycle",
                updatedAt: Date.now(),
              });
            } else if (requesterState === "deleted") {
              await deleteSessionEntryLifecycle({
                storePath,
                agentId: "main",
                archiveTranscript: false,
                target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              });
            }
            return {
              provider: "synthetic",
              model: "fixture",
              count: 1,
              wakeResult: "Generated a synthetic lighthouse.",
              attachments: [{ type: "image" as const, path: mediaPath, mimeType: "image/png" }],
            };
          },
        });
        expect(scheduled).toHaveLength(1);
        await scheduled[0]!();
        expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey, "main")).toBe(false);
        if (requesterState === "current" || requesterState === "retired-during-append") {
          expect(enqueue).toHaveBeenCalledOnce();
        } else {
          expect(enqueue).not.toHaveBeenCalled();
        }
        expect(appendSpy).toHaveBeenCalledOnce();
        if (requesterState === "current") {
          // Re-observing one completion cannot duplicate its retained notice.
          await scheduled[0]!();
        }
        resetGeneratedMediaTaskActivityForTests();
        await cleanupSessionStateForTest({ stateDir: state.stateDir });
        const events = await loadTranscriptEvents({ ...scope, sessionId });
        if (requesterState === "current") {
          const messages = events.filter((event) => isRecord(event) && event.type === "message");
          expect(messages).toHaveLength(1);
          expect(JSON.stringify(messages)).toContain(mediaPath);
          expect(JSON.stringify(messages)).toContain("delivery");
        } else {
          expect(events).toEqual([]);
          if (requesterState === "replaced") {
            expect(
              await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" }),
            ).toEqual([]);
          }
        }
      });
    },
  );
});

describe("media admission after requester lookup", () => {
  it("keeps a missing requester inline while retaining native operation tracking", async () => {
    await withOpenClawTestState({ prefix: "media-missing-requester-" }, async (state) => {
      await state.writeConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
      const sessionKey = "agent:main:missing-requester";
      const schedule = vi.fn();
      const run = vi.fn(async (handle) => {
        expect(handle).toMatchObject({ detach: false, requesterTranscript: undefined });
        expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey, "main")).toBe(true);
        return {
          provider: "synthetic",
          model: "fixture",
          count: 1,
          wakeResult: "inline result",
          contentText: "inline result",
          details: { generated: true },
        };
      });
      const result = await runMediaGenerationTask({
        lifecycle: imageGenerationTaskLifecycle,
        generationLabel: "image",
        sessionKey,
        requesterAgentId: "main",
        prompt: "synthetic lighthouse",
        requestKey: "missing-requester",
        scheduleBackgroundWork: schedule,
        onFailure: vi.fn(),
        run,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(schedule).not.toHaveBeenCalled();
      expect(result).toMatchObject({ content: [{ type: "text", text: "inline result" }] });
      expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey, "main")).toBe(false);
      expect(listMediaGenerationOperations(sessionKey, "main")).toEqual([
        expect.objectContaining({ status: "succeeded" }),
      ]);
    });
  });

  it.each([
    "invocation",
    "cancellation",
    "generation",
    "after-admission",
    "after-admission-cancellation",
    "after-admission-generation",
  ] as const)(
    "refuses late %s revocation without detached or foreground provider work",
    async (revocation) => {
      await withOpenClawTestState({ prefix: "media-admission-authority-" }, async (state) => {
        const sessionKey = "agent:main:media-admission";
        await state.writeConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        await replaceSessionEntry(
          { agentId: "main", storePath, sessionKey },
          {
            sessionId: "media-admission-session",
            updatedAt: 1,
          },
        );
        const readStarted = createDeferredCore();
        const resumeRead = createDeferredCore();
        const read = entryReader.withSessionEntryReadOnlyInWorker;
        vi.spyOn(entryReader, "withSessionEntryReadOnlyInWorker").mockImplementation(
          (scope, assertCurrent, consume) =>
            read(scope, assertCurrent, async (result) => {
              readStarted.resolve();
              await resumeRead.promise;
              return consume(result);
            }),
        );
        let current = true;
        if (revocation.startsWith("after-admission")) {
          const create = imageGenerationTaskLifecycle.createTaskRun;
          vi.spyOn(imageGenerationTaskLifecycle, "createTaskRun").mockImplementationOnce(
            async (params) => {
              const handle = await create(params);
              if (revocation === "after-admission-cancellation") {
                controller.abort(new Error("request cancelled after admission"));
              } else if (revocation === "after-admission-generation") {
                rotateAgentEventLifecycleGeneration();
              } else {
                current = false;
              }
              return handle;
            },
          );
        }
        const controller = new AbortController();
        const run = vi.fn();
        const schedule = vi.fn();
        const release = vi.fn(async () => {});
        const pending = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: {
              runId: "media-admission-run",
              instanceId: "media-admission-instance",
            },
            receiptAuthority: () => current,
            approvalSignals: [controller.signal],
          },
          () =>
            runMediaGenerationTask({
              lifecycle: imageGenerationTaskLifecycle,
              generationLabel: "image",
              sessionKey,
              requesterAgentId: "main",
              prompt: "synthetic lighthouse",
              requestKey: "synthetic-request",
              scheduleBackgroundWork: schedule,
              onFailure: vi.fn(),
              resources: { run: async (work) => work(), release },
              run,
            }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await readStarted.promise;
        if (revocation === "invocation") {
          current = false;
        } else if (revocation === "cancellation") {
          controller.abort(new Error("request cancelled"));
        } else if (revocation === "generation") {
          rotateAgentEventLifecycleGeneration();
        }
        resumeRead.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(run).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(listMediaGenerationOperations(sessionKey, "main")).toEqual(
          revocation === "after-admission" || revocation === "after-admission-cancellation"
            ? [expect.objectContaining({ status: "failed" })]
            : [],
        );
        expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey, "main")).toBe(false);
      });
    },
  );
});
