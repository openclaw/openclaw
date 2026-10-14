import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import * as entryReader from "../../config/sessions/session-entry-read-runtime.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as sessionDelivery from "../../infra/session-delivery-queue-storage.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  hasPendingGeneratedMediaTaskForSessionKey,
  listMediaGenerationOperations,
} from "../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { findDuplicateGuardImageGenerationTaskForSession } from "../media-generation-task-status.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import * as announceDelivery from "../subagents/announce/subagent-announce-delivery.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
import {
  imageGenerationTaskLifecycle,
  resolveMediaGenerateToolContext,
  runMediaGenerationTask,
} from "./media-generate-background.js";
import { buildMediaGenerateToolExecutionResult } from "./media-generate-result-shared.js";

const { resolveSandboxContext } = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn<typeof import("../sandbox/context.js").resolveSandboxContext>(),
}));
// mock-isolation: sandbox provisioning is synthetic; session ownership and writes are real.
vi.mock("../sandbox/context.js", () => ({ resolveSandboxContext }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

describe("undelivered generated media", () => {
  it.each([
    "current",
    "replaced",
    "rotated",
    "deleted",
    "retired-during-append",
    "retired-at-commit",
  ] as const)(
    "retains references only in the original live requester: %s",
    async (requesterState) => {
      await withOpenClawTestState({ prefix: "media-completion-retention-" }, async (state) => {
        const sessionKey = "agent:main:media-retention";
        const sessionId = "original-media-requester";
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
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
        let retaining = false;
        let revokedAtCommit = false;
        if (requesterState === "retired-at-commit") {
          appendSpy.mockImplementationOnce(async (params) => {
            retaining = true;
            try {
              return await append(params);
            } finally {
              retaining = false;
            }
          });
          probe.admission(admission, (request, grant, callback) => {
            if (retaining && request.stage === "commit") {
              revokedAtCommit = true;
              rotateAgentEventLifecycleGeneration();
            }
            callback(request, grant);
          });
        }
        if (requesterState === "retired-during-append") {
          appendSpy.mockImplementationOnce(async (params) => {
            await Promise.resolve();
            rotateAgentEventLifecycleGeneration();
            return append(params);
          });
        }
        const lifecycle = createMediaGenerationTaskLifecycle("image");
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
        assert(handle);
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
        if (
          requesterState === "current" ||
          requesterState === "retired-during-append" ||
          requesterState === "retired-at-commit"
        ) {
          expect(enqueue).toHaveBeenCalledOnce();
        } else {
          expect(enqueue).not.toHaveBeenCalled();
        }
        expect(appendSpy).toHaveBeenCalledOnce();
        if (requesterState === "retired-at-commit") {
          expect(revokedAtCommit).toBe(true);
        }
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
  it("detaches through the durable transcript while keeping each requesting peer's ownership", async () => {
    await withOpenClawTestState({ prefix: "media-shared-main-" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const requesterRunSessionKey = "agent:main:main";
      const firstKey = "agent:main:discord:default:direct:peer-a";
      const secondKey = "agent:main:discord:default:direct:peer-b";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const sessionId = "shared-media-requester";
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: requesterRunSessionKey },
        { sessionId, lifecycleRevision: "shared-lifecycle", updatedAt: 1 },
      );
      const prompt = "a synthetic lighthouse";
      const firstOrigin = { channel: "discord", accountId: "default", to: "user:peer-a" };
      const lifecycle = imageGenerationTaskLifecycle;
      const first = await lifecycle.createTaskRun({
        sessionKey: firstKey,
        requesterRunSessionKey,
        requesterAgentId: "main",
        requesterOrigin: firstOrigin,
        prompt,
      });
      expect(first).toMatchObject({
        detach: true,
        requesterSessionKey: firstKey,
        requesterOrigin: firstOrigin,
        requesterTranscript: {
          sessionKey: requesterRunSessionKey,
          sessionId,
          lifecycleRevision: "shared-lifecycle",
        },
      });
      const request = { prompt, agentId: "main" };
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(firstKey, request),
      ).toMatchObject({
        taskId: first?.taskId,
        requesterSessionKey: firstKey,
      });
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(secondKey, request),
      ).toBeUndefined();
      const second = await lifecycle.createTaskRun({
        sessionKey: secondKey,
        requesterRunSessionKey,
        requesterAgentId: "main",
        requesterOrigin: { ...firstOrigin, to: "user:peer-b" },
        prompt,
      });
      expect(second).toMatchObject({ detach: true, requesterSessionKey: secondKey });
      expect(second?.taskId).not.toBe(first?.taskId);
      for (const [sessionKey, handle] of [
        [firstKey, first],
        [secondKey, second],
      ] as const) {
        expect(
          await findDuplicateGuardImageGenerationTaskForSession(sessionKey, request),
        ).toMatchObject({
          taskId: handle?.taskId,
          requesterSessionKey: sessionKey,
        });
      }
      const deliver = vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      await expect(
        lifecycle.wakeTaskCompletion({
          handle: first,
          status: "ok",
          statusLabel: "completed successfully",
          result: "generated",
        }),
      ).resolves.toEqual({ status: "delivered" });
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterSessionKey: firstKey,
          targetRequesterSessionKey: requesterRunSessionKey,
          preparedRequester: expect.objectContaining({
            binding: expect.objectContaining({ sessionKey: requesterRunSessionKey, sessionId }),
          }),
          requesterSessionOrigin: firstOrigin,
          completionDirectOrigin: firstOrigin,
          directOrigin: firstOrigin,
        }),
      );
    });
  });

  it("keeps a missing requester inline while retaining native operation tracking", async () => {
    await withOpenClawTestState({ prefix: "media-missing-requester-" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
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
        const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
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
            read(scope, assertCurrent, async (result, owner) => {
              readStarted.resolve();
              await resumeRead.promise;
              return consume(result, owner);
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

describe("generated media sandbox lifecycle", () => {
  it.each([
    "current",
    "reset-during-generation",
    "recreate-during-generation",
    "reset-during-acquisition",
    "reset-after-gitignore",
    "reset-after-first-output",
    "read-only-during-generation",
    "workspace-during-generation",
  ] as const)("binds detached staging to the admitted session: %s", async (transition) => {
    await withOpenClawTestState({ prefix: "media-staging-lifecycle-" }, async (state) => {
      const workspace = state.workspaceDir;
      await fs.mkdir(workspace, { recursive: true });
      const mediaPath = state.path("image.png");
      const outputBytes = Buffer.from("synthetic generated media");
      await fs.writeFile(mediaPath, outputBytes);
      const sandbox = { root: workspace, bridge: createHostSandboxFsBridge(workspace) };
      const acquireSandbox = async () => ({ ...sandbox, [Symbol.dispose]() {} });
      const params = {
        kind: "image" as const,
        result: { provider: "test", model: "test", attempts: [] },
        attachments: [{ type: "image" as const, path: mediaPath }],
        mediaUrls: [mediaPath],
        maxBytes: 1024,
        details: {},
      };
      const sessionKey = "agent:main:media-staging";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const scope = { agentId: "main", sessionKey, storePath };
      const entry = { sessionId: "original", lifecycleRevision: "original", updatedAt: 1 };
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          entries: { main: { workspace } },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await replaceSessionEntry(scope, entry);
      const lifecycle = createMediaGenerationTaskLifecycle("image");
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterAgentId: "main",
        prompt: "synthetic images",
      });
      if (!handle?.detach) {
        throw new Error("Expected an admitted detached generation");
      }
      const changesConfig =
        transition === "read-only-during-generation" ||
        transition === "workspace-during-generation";
      const invalidate = async () => {
        if (changesConfig) {
          const replacement: OpenClawConfig = structuredClone(config);
          if (transition === "read-only-during-generation") {
            replacement.agents!.defaults!.sandbox!.workspaceAccess = "ro";
          } else {
            replacement.agents!.entries!.main!.workspace = state.path("successor-workspace");
          }
          setRuntimeConfigSnapshot(replacement);
        } else if (transition === "recreate-during-generation") {
          await deleteSessionEntryLifecycle({
            storePath,
            agentId: "main",
            archiveTranscript: false,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
          await replaceSessionEntry(scope, {
            sessionId: "successor",
            lifecycleRevision: "successor",
            updatedAt: 2,
          });
        } else {
          await resetSessionEntryLifecycle({
            storePath,
            agentId: "main",
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary: { context: "clear", reason: "reset", cwd: workspace },
            buildNextEntry: () => ({ ...entry, lifecycleRevision: "successor", updatedAt: 2 }),
          });
        }
      };
      const secondPath = path.join(path.dirname(params.mediaUrls[0]!), "second.png");
      await fs.writeFile(secondPath, outputBytes);
      const attachments = [...params.attachments, { type: "image" as const, path: secondPath }];
      const createFile = sandbox.bridge.createFileExclusive!.bind(sandbox.bridge);
      const written = vi
        .spyOn(sandbox.bridge, "createFileExclusive")
        .mockImplementation(async (request) => {
          const result = await createFile(request);
          if (
            (transition === "reset-after-gitignore" && request.filePath.endsWith(".gitignore")) ||
            (transition === "reset-after-first-output" && request.filePath.endsWith("/image.png"))
          ) {
            await invalidate();
          }
          return result;
        });
      const context = resolveMediaGenerateToolContext(
        "imageGenerationProviders",
        {
          config,
          agentSessionKey: sessionKey,
          sandboxAgentId: "main",
          requesterAgentId: "main",
          spawnWorkspaceDir: workspace,
          sandbox,
        },
        { warn: vi.fn(), error: vi.fn() },
        true,
      );
      if (!context?.acquireOutputSandbox) {
        throw new Error("Expected a sandboxed media tool");
      }
      resolveSandboxContext.mockResolvedValue(
        createSandboxTestContext({
          overrides: {
            workspaceDir: workspace,
            fsBridge: sandbox.bridge,
          },
        }),
      );
      const acquire = vi.fn(async (assertCurrent: () => void) => {
        if (changesConfig) {
          return context.acquireOutputSandbox!(assertCurrent);
        }
        if (transition === "reset-during-acquisition") {
          await invalidate();
        }
        return acquireSandbox();
      });
      const deliver = vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      const scheduled: Array<() => Promise<void>> = [];
      const generationStarted = createDeferredCore();
      const finishGeneration = createDeferredCore();
      const results: Array<Awaited<ReturnType<typeof buildMediaGenerateToolExecutionResult>>> = [];
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating synthetic images",
        toolName: "image_generate",
        onWakeFailure: vi.fn(),
        run: async () => {
          generationStarted.resolve();
          await finishGeneration.promise;
          const result = await buildMediaGenerateToolExecutionResult({
            ...params,
            attachments,
            mediaUrls: attachments.map((attachment) => attachment.path),
            sandbox: acquire,
            taskHandle: handle,
          });
          results.push(result);
          return result;
        },
      });
      expect(scheduled).toHaveLength(1);
      const pending = scheduled[0]!();
      await generationStarted.promise;
      try {
        if (transition.endsWith("during-generation")) {
          await invalidate();
        }
      } finally {
        finishGeneration.resolve();
        await pending;
      }
      const result = results[0];
      if (!result) {
        throw new Error("Expected generated media to survive staging refusal");
      }
      expect(result.attachments).toEqual(attachments);
      for (const attachment of attachments) {
        await expect(fs.readFile(attachment.path)).resolves.toEqual(outputBytes);
      }
      if (transition === "current") {
        expect(deliver).toHaveBeenCalledOnce();
        expect(written).toHaveBeenCalledTimes(3);
        const paths = result.details.sandboxPaths as string[];
        expect(paths).toHaveLength(2);
        for (const relativePath of paths) {
          await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(
            outputBytes,
          );
        }
      } else {
        if (changesConfig) {
          expect(deliver).toHaveBeenCalledOnce();
        } else {
          expect(deliver).not.toHaveBeenCalled();
        }
        expect(result.wakeResult).toContain(
          changesConfig
            ? "Sandbox copy unavailable: Error: The requesting sandbox configuration has changed"
            : "Sandbox copy unavailable: Error: The requesting session is no longer current",
        );
        const writesBeforeReset =
          transition === "reset-after-first-output"
            ? 2
            : transition === "reset-after-gitignore"
              ? 1
              : 0;
        expect(written).toHaveBeenCalledTimes(writesBeforeReset);
        if (transition === "reset-after-first-output") {
          expect(result.details.sandboxPaths).toHaveLength(1);
        } else {
          expect(result.details.sandboxPaths).toBeUndefined();
        }
        if (transition.endsWith("during-generation")) {
          if (changesConfig) {
            expect(acquire).toHaveBeenCalledOnce();
          } else {
            expect(acquire).not.toHaveBeenCalled();
          }
        }
        if (writesBeforeReset === 0) {
          await expect(fs.readdir(workspace)).resolves.toEqual([]);
        }
      }
    });
  });
});
