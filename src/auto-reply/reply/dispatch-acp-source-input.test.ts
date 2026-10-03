// Register shared provider boundaries before loading the dispatch implementation.
import "./dispatch-acp.shared.test-harness.js";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccess from "../../config/sessions/session-accessor.js";
import * as sessionEntry from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acpx.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAcpSourceTranscriptFixture, runDispatch } from "./dispatch-acp.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpSessionMeta,
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

const {
  auditMocks,
  bindingServiceMocks,
  managerMocks,
  sessionBinding,
  sessionKey,
  acpAttachmentBuffers,
  ACP_PNG_IMAGE_BYTES,
} = await import("./dispatch-acp.shared.test-harness.js");

describe("ACP source input lifecycle", () => {
  it.each([false, true])(
    "dispatches supplied transcript-only input without a source row (runtime committed: %s)",
    async (runtimePersisted) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const source = {
          agentId: "codex-acp",
          sessionKey: "agent:codex-acp:discord:channel:transcript-only",
          sessionId: "supplied-transcript-only-source",
          storePath: path.join(state.sessionsDir("codex-acp"), "sessions.json"),
        };
        const text = "Accept this supplied transcript-only input through ACP.";
        const recorder = createUserTurnTranscriptRecorder({
          target: { ...source, sessionEntry: undefined },
          input: { text },
        });
        if (runtimePersisted) {
          const committed = await persistUserTurnTranscript({
            ...source,
            sessionEntry: undefined,
            message: await recorder.resolveMessage(),
          });
          if (!committed) {
            throw new Error("Missing real runtime input receipt");
          }
          recorder.markRuntimePersisted(committed.message, committed.admission, { appended: true });
          expect(recorder.hasPersisted()).toBe(true);
          expect(recorder.getAdmissionReceipt()).toBeDefined();
        }
        expect(loadSessionEntryReadOnly(source)).toBeUndefined();
        let eventsAtSubmission: Awaited<ReturnType<typeof loadTranscriptEvents>> = [];
        let turnAdmission: AdmittedRunContext | undefined;
        const { emitAcpLifecycleEnd } = await vi.importActual<
          typeof import("../../agents/command/acp-lifecycle.js")
        >("../../agents/command/acp-lifecycle.js");
        auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
        managerMocks.runTurn.mockImplementationOnce(
          async ({
            admittedRunContext,
            onEvent,
          }: {
            admittedRunContext: AdmittedRunContext;
            onEvent: (event: unknown) => Promise<void>;
          }) => {
            turnAdmission = admittedRunContext;
            eventsAtSubmission = await loadTranscriptEvents(source);
            await onEvent({ type: "done", status: "completed" });
          },
        );
        const result = await runDispatch({
          bodyForAgent: text,
          cfg: createAcpTestConfig({ session: { store: source.storePath } }),
          ctxOverrides: { SessionKey: source.sessionKey, RawBody: text },
          userTurnTranscriptRecorder: recorder,
        });
        expect(recorder.hasPersisted()).toBe(true);
        expect(recorder.getAdmissionReceipt()).toMatchObject({
          sessionId: source.sessionId,
          sessionKey: source.sessionKey,
        });
        expect(managerMocks.runTurn).toHaveBeenCalledOnce();
        expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
        expect(eventsAtSubmission).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ role: "user", content: text }),
          }),
        );
        expect(loadSessionEntryReadOnly(source)).toBeUndefined();
        if (!turnAdmission) {
          throw new Error("Transcript-only ACP turn was not admitted");
        }
        expect(getAdmittedRunDelegatedAuthority(turnAdmission)).toBeUndefined();
      });
    },
  );

  it("keeps ACP handled through the default claiming hook when source settlement rejects", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, entry, recorder } = await createAcpSourceTranscriptFixture(
        state,
        sessionKey,
        "acp-settlement-write-failure",
        "Deliver this request once through ACP.",
      );
      managerMocks.resolveSessionAsync.mockResolvedValue({
        kind: "ready",
        sessionKey,
        agentId: target.agentId,
        meta: createAcpSessionMeta(),
        entry,
      });
      const text = "ACP already completed the accepted request.";
      const { emitAcpLifecycleEnd } = await vi.importActual<
        typeof import("../../agents/command/acp-lifecycle.js")
      >("../../agents/command/acp-lifecycle.js");
      auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
      const patch = vi.spyOn(sessionEntry, "patchSessionEntryCore");
      let turnAdmission: AdmittedRunContext | undefined;
      let settlementRejected = false;
      managerMocks.runTurn.mockImplementationOnce(
        async ({
          admittedRunContext,
          onEvent,
        }: {
          admittedRunContext: AdmittedRunContext;
          onEvent: (event: unknown) => Promise<void>;
        }) => {
          turnAdmission = admittedRunContext;
          await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
          await onEvent({ type: "done", status: "completed" });
          // Admission and ACP side effects succeeded; only terminal source persistence fails.
          patch.mockImplementationOnce(async () => {
            settlementRejected = true;
            throw new Error("ACP source SQLite settlement unavailable");
          });
        },
      );
      const { dispatcher } = createDispatcher();
      const event = {
        ctx: buildTestCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          BodyForAgent: "Deliver this request once through ACP.",
        }),
        runId: "acp-settlement-write-failure",
        sessionKey,
        inboundAudio: false,
        shouldRouteToOriginating: false,
        shouldSendToolSummaries: true,
        shouldSendFullToolDetails: false,
        sendPolicy: "allow" as const,
      };
      const hookContext = {
        cfg: createAcpTestConfig({ session: { store: target.storePath } }),
        dispatcher,
        userTurnTranscriptRecorder: recorder,
        recordProcessed: vi.fn(),
        markIdle: vi.fn(),
      };
      const fallback = vi.fn(() => ({
        handled: true,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      }));
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "reply_dispatch",
          pluginId: "acpx",
          priority: 10,
          handler: () => tryDispatchAcpReplyHook(event, hookContext),
        },
        { hookName: "reply_dispatch", pluginId: "fallback", handler: fallback },
      ]);
      try {
        const result = await runner.runReplyDispatch(event, hookContext);
        expect(settlementRejected).toBe(true);
        expect(result?.handled).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
        expect(managerMocks.runTurn).toHaveBeenCalledOnce();
        const deliveredText = [
          ...vi.mocked(dispatcher.sendBlockReply).mock.calls,
          ...vi.mocked(dispatcher.sendFinalReply).mock.calls,
        ]
          .map(([payload]) => payload.text ?? "")
          .join("");
        expect(deliveredText).toContain(text);
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          status: "running",
          activeWriterRunId: event.runId,
          acpSourceTurn: { sourceSessionId: target.sessionId, runId: event.runId },
        });
        if (!turnAdmission) {
          throw new Error("ACP turn was not admitted");
        }
        expect(getAdmittedRunDelegatedAuthority(turnAdmission)).toBeUndefined();
      } finally {
        patch.mockRestore();
      }
    });
  });

  it("persists canonical source ownership before public ACP takeover without an ingress recorder", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceSessionKey = "agent:codex-acp:discord:channel:thread-1";
      const targetSessionKey = "agent:codex-acp:acp:bound";
      const { target } = await createAcpSourceTranscriptFixture(
        state,
        sourceSessionKey,
        "acp-public-without-recorder",
        "Original accepted user request.",
      );
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        status: "done",
      });
      const acpTarget = { ...target, sessionKey: targetSessionKey, sessionId: "bound-acp-target" };
      const entry = await upsertSessionEntryCore(acpTarget, {
        sessionId: acpTarget.sessionId,
        updatedAt: 1,
        acp: createAcpSessionMeta(),
      });
      bindingServiceMocks.resolveByConversation.mockReturnValue(sessionBinding(targetSessionKey));
      managerMocks.resolveSessionAsync.mockResolvedValue({
        kind: "ready",
        sessionKey: targetSessionKey,
        agentId: target.agentId,
        meta: createAcpSessionMeta(),
        entry: entry ?? undefined,
      });
      let submitted = false;
      const sourceAtSubmission: { value: ReturnType<typeof loadSessionEntryReadOnly> } = {
        value: undefined,
      };
      let eventsAtSubmission: Awaited<ReturnType<typeof loadTranscriptEvents>> = [];
      const { emitAcpLifecycleEnd } = await vi.importActual<
        typeof import("../../agents/command/acp-lifecycle.js")
      >("../../agents/command/acp-lifecycle.js");
      auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          submitted = true;
          sourceAtSubmission.value = loadSessionEntryReadOnly(target);
          eventsAtSubmission = await loadTranscriptEvents(target);
          await onEvent({ type: "done", status: "completed" });
        },
      );
      const beforeMessageWrite = vi.fn((event: unknown) => {
        const { message } = event as { message: Record<string, unknown> };
        return { message: { ...message, content: "Approved original accepted user request." } };
      });
      const { registry } = createHookRunnerWithRegistry([
        {
          hookName: "reply_dispatch",
          pluginId: "acpx",
          handler: (event, context) =>
            tryDispatchAcpReplyHook(
              event as Parameters<typeof tryDispatchAcpReplyHook>[0],
              context as Parameters<typeof tryDispatchAcpReplyHook>[1],
            ),
        },
        { hookName: "before_message_write", pluginId: "input-policy", handler: beforeMessageWrite },
      ]);
      const previousRegistry = getGlobalPluginRegistry();
      const runtimePlugins = await import("../../agents/runtime-plugins.js");
      const loadRegistry = vi
        .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
        .mockReturnValue(registry);
      initializeGlobalHookRunner(registry);
      const replyResolver = vi.fn(async () => ({ text: "native fallback" }));
      const imagePath = "/tmp/acp-source-original.png";
      acpAttachmentBuffers.set(imagePath, ACP_PNG_IMAGE_BYTES);
      try {
        const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
        await dispatchReplyFromConfig({
          cfg: createAcpTestConfig({
            session: { store: target.storePath },
            agents: { entries: { "codex-acp": {} }, defaults: { workspace: state.workspaceDir } },
            plugins: { enabled: false },
          }),
          ctx: buildTestCtx({
            Provider: "discord",
            Surface: "discord",
            From: "discord:channel:thread-1",
            To: "thread-1",
            ChatType: "channel",
            SessionKey: sourceSessionKey,
            Body: "Original accepted user request.",
            RawBody: "Original accepted user request.",
            BodyForAgent: "Prepared ACP prompt with image context.",
            MessageSid: "source-message-no-recorder",
            Timestamp: 1_700_000_000_000,
            SenderId: "original-channel-person",
            media: [{ kind: "image", path: imagePath, contentType: "image/png" }],
          }),
          dispatcher: createDispatcher().dispatcher,
          replyOptions: { runId: "acp-public-without-recorder" },
          replyResolver,
        });
        expect(submitted).toBe(true);
        expect(replyResolver).not.toHaveBeenCalled();
        expect(sourceAtSubmission.value).toMatchObject({
          status: "running",
          activeWriterRunId: "acp-public-without-recorder",
          acpSourceTurn: {
            sourceSessionId: target.sessionId,
            runId: "acp-public-without-recorder",
          },
        });
        expect(loadSessionEntryReadOnly(acpTarget)?.acpSourceTurn).toBeUndefined();
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          status: "done",
        });
        expect(loadSessionEntryReadOnly(target)?.acpSourceTurn).toBeUndefined();
        expect(beforeMessageWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.objectContaining({ content: "Original accepted user request." }),
          }),
          expect.objectContaining({ sessionKey: sourceSessionKey }),
        );
        expect(eventsAtSubmission).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "Approved original accepted user request.",
              timestamp: 1_700_000_000_000,
              __openclaw: expect.objectContaining({
                senderId: "original-channel-person",
                transport: expect.objectContaining({
                  channel: "discord",
                  messageId: "source-message-no-recorder",
                }),
                media: [
                  expect.objectContaining({
                    kind: "image",
                    path: imagePath,
                    contentType: "image/png",
                  }),
                ],
                mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
              }),
            }),
          }),
        );
      } finally {
        loadRegistry.mockRestore();
        if (previousRegistry) {
          initializeGlobalHookRunner(previousRegistry);
        } else {
          resetGlobalHookRunner();
        }
      }
    });
  });

  it.each([
    { revision: undefined, producerFence: false, joinPhase: undefined },
    { revision: "supplied-source-revision", producerFence: false, joinPhase: undefined },
    { revision: undefined, producerFence: true, joinPhase: undefined },
    { revision: "supplied-source-revision", producerFence: true, joinPhase: undefined },
    { revision: undefined, producerFence: false, joinPhase: "input" },
    { revision: "supplied-source-revision", producerFence: false, joinPhase: "worker" },
    {
      revision: "supplied-source-revision",
      producerFence: false,
      joinPhase: "input",
      identityRebound: true,
    },
    { revision: undefined, producerFence: false, joinPhase: "input", sameOwner: true },
    {
      revision: "supplied-source-revision",
      producerFence: false,
      joinPhase: "worker",
      sameOwner: true,
    },
    {
      revision: "runtime-source-revision",
      producerFence: false,
      joinPhase: undefined,
      sameOwner: true,
      runtimePersisted: true,
    },
    {
      revision: "runtime-source-revision",
      producerFence: false,
      joinPhase: undefined,
      sameOwner: true,
      runtimePersisted: true,
      sourceContextAbsent: true,
    },
    {
      revision: "runtime-source-revision",
      producerFence: false,
      joinPhase: undefined,
      sameOwner: true,
      runtimePersisted: true,
      runtimeReceiptAbsent: true,
    },
    {
      revision: "runtime-source-revision",
      producerFence: false,
      joinPhase: undefined,
      sameOwner: true,
      runtimePersisted: true,
      recorderStoreCopy: true,
    },
  ])(
    "fences supplied public ACP input to $revision before persistence (producer fence: $producerFence, joined: $joinPhase, rebound: $identityRebound, same owner: $sameOwner, runtime committed: $runtimePersisted, source context absent: $sourceContextAbsent, runtime receipt absent: $runtimeReceiptAbsent, copied recorder store: $recorderStoreCopy)",
    async ({
      revision,
      producerFence,
      joinPhase,
      identityRebound,
      sameOwner,
      runtimePersisted,
      sourceContextAbsent,
      runtimeReceiptAbsent,
      recorderStoreCopy,
    }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const requestId = `supplied-public-revision-race-${revision ?? "revisionless"}-${producerFence}-${joinPhase ?? "new"}-${identityRebound ?? false}-${sameOwner ?? false}-${runtimePersisted ?? false}-${sourceContextAbsent ?? false}-${runtimeReceiptAbsent ?? false}-${recorderStoreCopy ?? false}`;
        const sourceSessionKey = "agent:codex-acp:discord:channel:supplied-revision-race";
        const targetSessionKey = "agent:codex-acp:acp:supplied-revision-target";
        const text = "Keep this supplied request in its admitted source generation.";
        const successorSessionId = "successor-supplied-source";
        const { target } = await createAcpSourceTranscriptFixture(
          state,
          sourceSessionKey,
          "supplied-public-source",
          text,
        );
        const sourceEntry = await sessionEntry.patchSessionEntryCore(target, () => ({
          status: "done",
          lifecycleRevision: revision,
        }));
        if (!sourceEntry) {
          throw new Error("Missing supplied source generation fixture");
        }
        const recorderTarget = recorderStoreCopy
          ? { ...target, storePath: path.join(state.workspaceDir, "copied-source.sqlite") }
          : target;
        if (recorderStoreCopy) {
          await upsertSessionEntryCore(recorderTarget, sourceEntry);
        }
        const input = createDeferredCore<{ text: string }>();
        const resolving = createDeferredCore();
        const prepared = createDeferredCore();
        const resumeWorker = createDeferredCore();
        const recorder = createUserTurnTranscriptRecorder({
          ...(joinPhase
            ? {
                resolveInput: async () => {
                  resolving.resolve();
                  return await input.promise;
                },
              }
            : { input: { text } }),
          target: identityRebound
            ? async () => {
                const entry = await withSessionEntryReadOnlyInWorker(
                  { ...target, readConsistency: "latest" },
                  () => {},
                  async (read) => {
                    if (!read.ok) {
                      throw read.error;
                    }
                    return read.value;
                  },
                );
                if (!entry) {
                  throw new Error("Missing rebound source target");
                }
                return { ...target, sessionId: entry.sessionId, sessionEntry: entry };
              }
            : { ...recorderTarget, sessionEntry: sourceEntry },
          ...(producerFence ? { expectedLifecycleRevision: revision ?? null } : {}),
        });
        if (runtimePersisted) {
          const committed = await persistUserTurnTranscript({
            ...recorderTarget,
            sessionEntry: sourceEntry,
            message: await recorder.resolveMessage(),
            expectedLifecycleRevision: revision ?? null,
          });
          if (!committed) {
            throw new Error("Missing real canonical runtime input receipt");
          }
          if (runtimeReceiptAbsent) {
            recorder.markRuntimePersisted();
          } else {
            recorder.markRuntimePersisted(committed.message, committed.admission, {
              appended: true,
            });
          }
          expect(recorder.hasPersisted()).toBe(true);
          expect(recorder.getAdmissionReceipt() === undefined).toBe(Boolean(runtimeReceiptAbsent));
        }
        if (!producerFence && revision && !joinPhase && !runtimePersisted) {
          expect(
            await recorder.stageApproved?.({
              runId: requestId,
              assertCurrent: () => {},
              assertAdmittedCurrent: () => {},
            }),
          ).toBe(true);
        }
        const stage = vi.spyOn(recorder, "stageApproved");
        const finish = vi.spyOn(recorder, "finishPendingInput");
        let workerPrepared = false;
        const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
        const execution = vi
          .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
          .mockImplementation((...args) => {
            const owner = capture(...args);
            return {
              ...owner,
              get fileIdentity() {
                return owner.fileIdentity;
              },
              runExisting: (source, operation, options) =>
                owner.runExisting(
                  source,
                  (worker) =>
                    operation({
                      execute: async (command, commandOptions) => {
                        const result = await worker.execute(command, commandOptions);
                        if (
                          joinPhase === "worker" &&
                          !workerPrepared &&
                          command.type === "session.turn.prepare"
                        ) {
                          workerPrepared = true;
                          prepared.resolve();
                          await resumeWorker.promise;
                        }
                        return result;
                      },
                    }),
                  options,
                ),
            };
          });
        const initialWrite = joinPhase
          ? recorder
              .persistApproved(
                sameOwner
                  ? {
                      expectedSessionId: target.sessionId,
                      expectedLifecycleRevision: revision ?? null,
                    }
                  : undefined,
              )
              .then(
                () => undefined,
                () => undefined,
              )
          : undefined;
        if (joinPhase) {
          await resolving.promise;
        }
        let changed = false;
        const originalApprove = recorder.persistApproved;
        const commitJoin = createDeferredCore<Awaited<ReturnType<typeof originalApprove>>>();
        let commitOptions: Parameters<typeof originalApprove>[0];
        let commitSeen = false;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admission =
          joinPhase === "worker"
            ? vi
                .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
                .mockImplementation((callback, attachment) =>
                  createAdmission((request, grant) => {
                    if (request.stage === "commit" && commitOptions && !commitSeen) {
                      commitSeen = true;
                      // Add the real joined condition before the unchanged synchronous grant.
                      void originalApprove(commitOptions).then(
                        commitJoin.resolve,
                        commitJoin.reject,
                      );
                    }
                    callback(request, grant);
                  }, attachment),
                )
            : undefined;
        const approve = vi
          .spyOn(recorder, "persistApproved")
          .mockImplementation(async (options) => {
            if (!joinPhase) {
              return await originalApprove(options);
            }
            const joined = joinPhase === "input" ? originalApprove(options) : undefined;
            if (!sameOwner) {
              await sessionEntry.patchSessionEntryCore(target, () => ({
                lifecycleRevision: identityRebound ? revision : "successor-supplied-revision",
                ...(identityRebound ? { sessionId: successorSessionId } : {}),
              }));
              changed = true;
            }
            input.resolve({ text });
            if (joinPhase === "worker") {
              await prepared.promise;
              if (!options) {
                throw new Error("Missing captured ACP source restriction");
              }
              commitOptions = options;
              resumeWorker.resolve();
              return await commitJoin.promise;
            }
            const pending = joined ?? originalApprove(options);
            resumeWorker.resolve();
            return await pending;
          });
        const acpTarget = {
          ...target,
          sessionKey: targetSessionKey,
          sessionId: "supplied-acp-target",
        };
        const entry = await upsertSessionEntryCore(acpTarget, {
          sessionId: acpTarget.sessionId,
          updatedAt: 1,
          acp: createAcpSessionMeta(),
        });
        bindingServiceMocks.resolveByConversation.mockReturnValue(sessionBinding(targetSessionKey));
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "ready",
          sessionKey: targetSessionKey,
          agentId: target.agentId,
          meta: createAcpSessionMeta(),
          entry: entry ?? undefined,
        });
        const sourceAtSubmission: { value: ReturnType<typeof loadSessionEntryReadOnly> } = {
          value: undefined,
        };
        const { emitAcpLifecycleEnd } = await vi.importActual<
          typeof import("../../agents/command/acp-lifecycle.js")
        >("../../agents/command/acp-lifecycle.js");
        auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
        managerMocks.runTurn.mockImplementationOnce(
          async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
            sourceAtSubmission.value = loadSessionEntryReadOnly(target);
            await onEvent({ type: "done", status: "completed" });
          },
        );
        const { registry } = createHookRunnerWithRegistry([
          {
            hookName: "reply_dispatch",
            pluginId: "acpx",
            handler: (event, context) =>
              tryDispatchAcpReplyHook(
                event as Parameters<typeof tryDispatchAcpReplyHook>[0],
                context as Parameters<typeof tryDispatchAcpReplyHook>[1],
              ),
          },
        ]);
        const previousRegistry = getGlobalPluginRegistry();
        const runtimePlugins = await import("../../agents/runtime-plugins.js");
        const loadRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        initializeGlobalHookRunner(registry);
        const replyResolver = vi.fn(async () => ({ text: "native fallback" }));
        const originalPersist = sessionAccess.persistSessionTranscriptTurn;
        const persist = vi
          .spyOn(sessionAccess, "persistSessionTranscriptTurn")
          .mockImplementation(async (scope, options) => {
            expect(scope.sessionKey).toBe(sourceSessionKey);
            expect(scope.sessionId).toBe(identityRebound ? successorSessionId : target.sessionId);
            expect(producerFence).toBe(false);
            if (!joinPhase) {
              changed = true;
              await sessionEntry.patchSessionEntryCore(target, () => ({
                lifecycleRevision: "successor-supplied-revision",
              }));
            }
            return await originalPersist(scope, options);
          });
        try {
          if (producerFence) {
            // The producer captured its generation before ACP sees the successor.
            await sessionEntry.patchSessionEntryCore(target, () => ({
              lifecycleRevision: "successor-supplied-revision",
            }));
            changed = true;
          }
          const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
          const dispatchParams = {
            cfg: createAcpTestConfig({
              session: { store: target.storePath },
              agents: { entries: { "codex-acp": {} }, defaults: { workspace: state.workspaceDir } },
              plugins: { enabled: false },
            }),
            ctx: buildTestCtx({
              Provider: "discord",
              Surface: "discord",
              From: "discord:channel:supplied-revision-race",
              To: "supplied-revision-race",
              ChatType: "channel",
              SessionKey: sourceContextAbsent ? undefined : sourceSessionKey,
              Body: text,
              RawBody: text,
              BodyForAgent: text,
              MessageSid: requestId,
            }),
            dispatcher: createDispatcher().dispatcher,
            replyOptions: {
              runId: requestId,
              userTurnTranscriptRecorder: recorder,
            },
            replyResolver,
          };
          if (sourceContextAbsent) {
            // Internal target-only compatibility; public absent-context coverage is in settlement tests.
            await runDispatch({
              bodyForAgent: text,
              cfg: dispatchParams.cfg,
              ctx: dispatchParams.ctx,
              runId: requestId,
              sessionKeyOverride: targetSessionKey,
              userTurnTranscriptRecorder: recorder,
            });
          } else {
            await dispatchReplyFromConfig(dispatchParams);
          }
          expect(changed).toBe(!sameOwner);
          await initialWrite;
          if (joinPhase === "worker") {
            expect(workerPrepared).toBe(true);
            expect(commitSeen).toBe(true);
          }
          if (producerFence || runtimePersisted) {
            expect(persist).not.toHaveBeenCalled();
          } else {
            expect(persist).toHaveBeenCalledOnce();
          }
          const events = await loadTranscriptEvents(
            identityRebound ? { ...target, sessionId: successorSessionId } : target,
          );
          const sourceInputs = events.filter(
            (event) =>
              isRecord(event) &&
              event.type === "message" &&
              isRecord(event.message) &&
              event.message.role === "user",
          );
          expect(sourceInputs).toHaveLength(sameOwner && !recorderStoreCopy ? 1 : 0);
          if (recorderStoreCopy) {
            expect(
              (await loadTranscriptEvents(recorderTarget)).filter(
                (event) =>
                  isRecord(event) &&
                  event.type === "message" &&
                  isRecord(event.message) &&
                  event.message.role === "user",
              ),
            ).toHaveLength(1);
          }
          const shouldSubmit = sameOwner && !runtimeReceiptAbsent && !recorderStoreCopy;
          expect({
            providerCalls: managerMocks.runTurn.mock.calls.length,
            nativeCalls: replyResolver.mock.calls.length,
            sourceAtSubmission: isRecord(sourceAtSubmission.value)
              ? (sourceAtSubmission.value.acpSourceTurn ?? null)
              : null,
          }).toMatchObject({
            providerCalls: shouldSubmit ? 1 : 0,
            nativeCalls: 0,
            sourceAtSubmission: shouldSubmit
              ? { sourceSessionId: target.sessionId, runId: requestId, targetSessionKey }
              : null,
          });
          expect(loadSessionEntryReadOnly(target)).toMatchObject({
            status: "done",
            sessionId: identityRebound ? successorSessionId : target.sessionId,
          });
          expect(loadSessionEntryReadOnly(target)?.lifecycleRevision).toBe(
            sameOwner || identityRebound ? revision : "successor-supplied-revision",
          );
          expect(loadSessionEntryReadOnly(target)?.acpSourceTurn).toBeUndefined();
          expect(loadSessionEntryReadOnly(acpTarget)?.acpSourceTurn).toBeUndefined();
          expect(stage).not.toHaveBeenCalled();
          expect(finish).not.toHaveBeenCalled();
        } finally {
          input.resolve({ text });
          resumeWorker.resolve();
          await initialWrite;
          approve.mockRestore();
          admission?.mockRestore();
          execution.mockRestore();
          stage.mockRestore();
          finish.mockRestore();
          recorder.finishPendingInput?.("interrupted");
          persist.mockRestore();
          loadRegistry.mockRestore();
          if (previousRegistry) {
            initializeGlobalHookRunner(previousRegistry);
          } else {
            resetGlobalHookRunner();
          }
        }
      });
    },
  );

  it.each([undefined, "captured-source-revision"])(
    "rejects an ACP input append after captured source revision %s changes",
    async (revision) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sourceSessionKey = "agent:codex-acp:discord:channel:generation-race";
        const { target } = await createAcpSourceTranscriptFixture(
          state,
          sourceSessionKey,
          "acp-input-generation-race",
          "Keep this in the admitted source.",
        );
        await sessionEntry.patchSessionEntryCore(target, () => ({
          status: "done",
          lifecycleRevision: revision,
        }));
        const originalPersist = sessionAccess.persistSessionTranscriptTurn;
        let changed = false;
        const persist = vi
          .spyOn(sessionAccess, "persistSessionTranscriptTurn")
          .mockImplementationOnce(async (scope, options) => {
            changed = true;
            await sessionEntry.patchSessionEntryCore(target, () => ({
              lifecycleRevision: "successor-source-revision",
            }));
            return await originalPersist(scope, options);
          });
        try {
          await runDispatch({
            bodyForAgent: "Keep this in the admitted source.",
            cfg: createAcpTestConfig({ session: { store: target.storePath } }),
            ctxOverrides: {
              SessionKey: sourceSessionKey,
              RawBody: "Keep this in the admitted source.",
            },
          });
          expect(changed).toBe(true);
          expect(managerMocks.runTurn).not.toHaveBeenCalled();
          // A refused generation must not leave accepted input in its successor's custody.
          expect((await listSessionPendingInputs(target)).items).toHaveLength(0);
          expect(
            (await loadTranscriptEvents(target)).filter(
              (event) =>
                isRecord(event) &&
                event.type === "message" &&
                isRecord(event.message) &&
                event.message.role === "user",
            ),
          ).toHaveLength(0);
          expect(loadSessionEntryReadOnly(target)).toMatchObject({
            status: "done",
            lifecycleRevision: "successor-source-revision",
          });
          expect(loadSessionEntryReadOnly(target)?.acpSourceTurn).toBeUndefined();
        } finally {
          persist.mockRestore();
        }
      });
    },
  );

  it("keeps canonical source input policy refusal ahead of ACP submission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target } = await createAcpSourceTranscriptFixture(
        state,
        "agent:codex-acp:discord:channel:blocked-input",
        "blocked-source-input",
        "Refuse this input before submission.",
      );
      const policy = vi.fn(() => ({ block: true }));
      const { registry } = createHookRunnerWithRegistry([
        { hookName: "before_message_write", pluginId: "input-policy", handler: policy },
      ]);
      const previousRegistry = getGlobalPluginRegistry();
      initializeGlobalHookRunner(registry);
      try {
        await runDispatch({
          bodyForAgent: "Refuse this input before submission.",
          cfg: createAcpTestConfig({ session: { store: target.storePath } }),
          ctxOverrides: {
            SessionKey: target.sessionKey,
            RawBody: "Refuse this input before submission.",
          },
        });
        expect(policy).toHaveBeenCalled();
        expect(managerMocks.runTurn).not.toHaveBeenCalled();
        expect(loadSessionEntryReadOnly(target)?.acpSourceTurn).toBeUndefined();
        expect(
          (await loadTranscriptEvents(target)).filter(
            (event) => isRecord(event) && event.type === "message",
          ),
        ).toHaveLength(0);
      } finally {
        if (previousRegistry) {
          initializeGlobalHookRunner(previousRegistry);
        } else {
          resetGlobalHookRunner();
        }
      }
    });
  });

  it.each([undefined, "agent:codex-acp:discord:channel:absent-source"])(
    "preserves transcript-only ACP dispatch when canonical source %s is absent",
    async (sourceSessionKey) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { target, entry } = await createAcpSourceTranscriptFixture(
          state,
          sessionKey,
          "legacy-target-only",
          "Target transcript only.",
        );
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "ready",
          sessionKey,
          agentId: target.agentId,
          meta: createAcpSessionMeta(),
          entry,
        });
        await runDispatch({
          bodyForAgent: "Existing transcript-only ACP request.",
          cfg: createAcpTestConfig({ session: { store: target.storePath } }),
          ctxOverrides: { SessionKey: sourceSessionKey },
        });
        expect(managerMocks.runTurn).toHaveBeenCalledOnce();
        expect(loadSessionEntryReadOnly(target)?.acpSourceTurn).toBeUndefined();
        if (sourceSessionKey) {
          expect(
            loadSessionEntryReadOnly({ ...target, sessionKey: sourceSessionKey }),
          ).toBeUndefined();
        }
      });
    },
  );
});
