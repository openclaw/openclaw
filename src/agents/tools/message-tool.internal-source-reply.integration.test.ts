// Integration coverage for real cron message authority and targetless WebChat
// replies through the internal source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { mirrorDeliveredReplyToTranscript } from "../../auto-reply/reply/dispatch-from-config.transcript.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as sessionTranscript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { persistInternalSourceReply } from "../../gateway/internal-source-reply-persistence.js";
import * as managedMedia from "../../gateway/managed-image-attachments.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "../../infra/sqlite-worker-transfer.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import * as effectAuthority from "../../shared/effect-authority.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createMessageTool } from "./message-tool-execution.js";
import { withCronMessageRun } from "./message-tool.cron.test-support.js";

// Internal WebChat sends have no external channels to discover.
const INTERNAL_SOURCE_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

function createCurrentSourceMessageTool(
  params: NonNullable<Parameters<typeof createMessageTool>[0]> = {},
) {
  return createMessageTool({
    config: { agents: { entries: { main: {} } } },
    preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
    currentChannelProvider: "webchat",
    sourceReplyDeliveryMode: "automatic",
    agentSessionKey: "agent:main:webchat:dm:dashboard",
    runId: "webchat-run",
    sandboxRoot: params.sandboxFsBridge ? params.workspaceDir : undefined,
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
    ...params,
  });
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

describe("WebChat message tool internal source reply", () => {
  it("refuses an internal-source transcript commit after its real cron admission closes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-source-commit-" },
      async (state) => {
        const sessionKey = "agent:main:webchat:dm:cron-source-commit";
        const sessionId = "cron-source-commit-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        await withCronMessageRun(
          {
            cfg: {
              agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
              tools: { allow: ["message"] },
            },
            storePath: state.statePath("cron", "internal-source.json"),
            sessionKey,
            sessionId,
          },
          async (owner) => {
            const message = "must never become a committed assistant message";
            let commitRequests = 0;
            let granted = 0;
            const create = workerAdmission.createSqliteWorkerOperationAdmission;
            const admission = vi
              .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) => {
                let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
                let transferId: number | undefined;
                let assistantTurn = false;
                return create((request, grant) => {
                  const facts =
                    isRecord(request.facts) && request.facts.kind === "session-entry-current"
                      ? request.facts.domainFacts
                      : request.facts;
                  const publication = isRecord(facts) ? facts.publication : undefined;
                  if (isRecord(publication)) {
                    if (publication.kind === "session-entry-patch-transfer") {
                      // SAFETY: The real session-entry worker emits this typed transfer handle.
                      const handle = publication.handle as SqliteWorkerTransferHandle;
                      transferId = handle.id;
                      assistantTurn = false;
                      receiver = createSqliteWorkerTransferReceiver(handle, (record) => {
                        if (
                          record.kind === "patch" &&
                          isRecord(record.value) &&
                          record.value.kind === "session-turn" &&
                          isRecord(record.value.result) &&
                          Array.isArray(record.value.result.appendedMessages)
                        ) {
                          assistantTurn = record.value.result.appendedMessages.some(
                            (appended: unknown) =>
                              isRecord(appended) &&
                              isRecord(appended.message) &&
                              appended.message.role === "assistant" &&
                              readAssistantDisplayContent(appended.message).some(
                                (block) => block.type === "text" && block.text === message,
                              ),
                          );
                        }
                      });
                    } else if (publication.kind === "session-entry-patch-frame") {
                      // SAFETY: This frame belongs to the intercepted worker transfer above.
                      receiver?.accept(publication.frame as SqliteWorkerTransferFrame);
                    } else if (
                      request.stage === "commit" &&
                      publication.kind === "session-entry-patch-committed" &&
                      publication.transferId === transferId &&
                      assistantTurn
                    ) {
                      commitRequests += 1;
                      owner.closeAdmission();
                      return admit(request, () => {
                        const accepted = grant();
                        granted += Number(accepted);
                        return accepted;
                      });
                    }
                  }
                  return admit(request, grant);
                }, attachment);
              });
            try {
              const tool = owner.createTool({
                preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
                currentChannelProvider: "webchat",
                sourceReplyDeliveryMode: "automatic",
              });
              const outcome = await tool
                .execute("cron-source-commit", { action: "send", message })
                .then(
                  (result) => ({ result }),
                  (error: unknown) => ({ error }),
                );
              const assistants = (await loadTranscriptEvents(scope)).filter(
                (event) => readTranscriptEventMessage(event)?.role === "assistant",
              );
              expect({ commitRequests, granted, assistants }).toEqual({
                commitRequests: 1,
                granted: 0,
                assistants: [],
              });
              expect(outcome).toHaveProperty("error");
            } finally {
              admission.mockRestore();
            }
          },
        );
      },
    );
  });

  it("downloads scheduled current-source media before holding transcript persistence authority", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-source-remote-media-" },
      async (state) => {
        const sessionKey = "agent:main:webchat:dm:cron-source-media";
        const sessionId = "cron-source-media-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        await withCronMessageRun(
          {
            cfg: {
              agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
              tools: { allow: ["message"] },
            },
            storePath: state.statePath("cron", "internal-source-media.json"),
            sessionKey,
            sessionId,
          },
          async (owner) => {
            let activePersistenceUses = 0;
            const prepare = effectAuthority.prepareEffectAuthority;
            const preparation = vi
              .spyOn(effectAuthority, "prepareEffectAuthority")
              .mockImplementation(async () => {
                const use = await prepare();
                if (!use) {
                  return use;
                }
                const observed: effectAuthority.PreparedEffectUse = {
                  ...use,
                  async persist(run) {
                    activePersistenceUses += 1;
                    try {
                      return await use.persist(run);
                    } finally {
                      activePersistenceUses -= 1;
                    }
                  },
                };
                return observed;
              });
            const createMedia = managedMedia.createManagedOutgoingMediaBlocks;
            const mediaPreparation = vi
              .spyOn(managedMedia, "createManagedOutgoingMediaBlocks")
              .mockImplementation((...args) => {
                // Fail before a nested FIFO acquire can deadlock the negative control's cleanup.
                expect(activePersistenceUses).toBe(0);
                return createMedia(...args);
              });
            const fetchStarted = Promise.withResolvers<void>();
            const response = Promise.withResolvers<Response>();
            const fetch = vi.fn(() => {
              fetchStarted.resolve();
              return response.promise;
            });
            vi.stubGlobal("fetch", fetch);
            let execution: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
            const respond = () =>
              response.resolve(
                new Response(new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")), {
                  headers: { "content-type": "image/png" },
                }),
              );
            try {
              const tool = owner.createTool({
                preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
                currentChannelProvider: "webchat",
                sourceReplyDeliveryMode: "automatic",
              });
              const args = {
                action: "send",
                message: "Remote media from a scheduled current-source reply.",
                media: "https://93.184.216.34/proof.png",
              };
              execution = tool.execute("cron-source-media", args);
              await Promise.race([
                fetchStarted.promise,
                execution.then(() => {
                  throw new Error("Scheduled source reply completed before its media request");
                }),
              ]);
              expect(activePersistenceUses).toBe(0);
              respond();
              const result = await execution;
              expect(result.details).toMatchObject({
                sourceReplySink: "internal-ui",
                sourceReplyTranscriptOwner: true,
              });
              await tool.execute("cron-source-media", args);
              const assistants = (await loadTranscriptEvents(scope))
                .map(readTranscriptEventMessage)
                .filter((message) => message?.role === "assistant");
              expect(assistants).toHaveLength(1);
              expect(readAssistantDisplayContent(assistants[0])).toEqual([
                { type: "text", text: args.message },
                expect.objectContaining({
                  type: "image",
                  artifactId: expect.stringMatching(/^artifact_managed_image_/u),
                }),
              ]);
              expect(fetch).toHaveBeenCalledTimes(1);
            } finally {
              respond();
              await execution?.catch(() => undefined);
              vi.unstubAllGlobals();
              mediaPreparation.mockRestore();
              preparation.mockRestore();
            }
          },
        );
      },
    );
  });

  it("projects a real targetless send and preserves the automatic final reply", async () => {
    const tool = createCurrentSourceMessageTool();

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Visible progress from the message tool.",
    });
    expect(toolResult.details).toMatchObject({
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplySink: "internal-ui",
      sourceReply: { text: "Visible progress from the message tool." },
    });
    expect(toolResult.content).toEqual([
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ]);

    const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
    expect(sourceReply).toMatchObject({ text: "Visible progress from the message tool." });

    const embeddedPayloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Visible automatic final reply."],
      lastAssistant: undefined,
      currentAssistant: undefined,
      sessionKey: "agent:main:webchat:dm:dashboard",
      sourceReplyDeliveryMode: "automatic",
      messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
      runId: "webchat-run",
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });
    const { replyPayloads: payloads } = await buildReplyPayloads({
      payloads: embeddedPayloads,
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      messagingToolSentTexts: ["Visible progress from the message tool."],
    });

    expect(payloads.map((payload) => payload.text)).toEqual([
      "Visible progress from the message tool.",
      "Visible automatic final reply.",
    ]);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:webchat:dm:dashboard",
        text: "Visible progress from the message tool.",
        idempotencyKey: "webchat-run:internal-source-reply:0",
      },
    });
    expect(getReplyPayloadMetadata(payloads[1] as object)?.sourceReplyTranscriptMirror).toBe(
      undefined,
    );
  });

  it("keeps the visible receipt for a WebChat user turn with message-tool-only replies", async () => {
    const tool = createCurrentSourceMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: { kind: "external_user", sourceChannel: "webchat" },
    });

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Reply the user reads in the Control UI.",
    });

    expect(toolResult.content).toEqual([
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ]);
  });

  it("reports a route-less inter-session send as a transcript record, not a channel delivery", async () => {
    const tool = createCurrentSourceMessageTool({
      agentSessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "sessions_send",
      },
    });

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Child task finished.",
    });

    expect(toolResult.details).toMatchObject({
      target: "current-run",
      sourceReplySink: "internal-ui",
    });
    expect(toolResult.content).toEqual([
      {
        type: "text",
        text: "Recorded reply in the current session transcript via internal-ui. This send did not deliver it to an external channel.",
      },
    ]);
  });

  it("stages a trusted HTML buffer before acknowledging the current-source send", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-buffer-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const tool = createCurrentSourceMessageTool({ workspaceDir: state.workspaceDir });
        const attachment = Buffer.from("<!doctype html><h1>Proof</h1>");

        const toolResult = await tool.execute("message-buffer-call", {
          action: "send",
          message: "Attached proof.",
          buffer: attachment.toString("base64"),
          filename: "proof.html",
          contentType: "text/html",
        });

        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply?.text).toBe("Attached proof.");
        expect(sourceReply?.mediaUrls).toHaveLength(1);
        expect(sourceReply?.attachments).toEqual([
          expect.objectContaining({
            name: "proof.html",
            mimeType: "text/html",
            trustedLocalMedia: true,
          }),
        ]);
        const mediaPath = sourceReply?.mediaUrls?.[0];
        expect(mediaPath).toBeTruthy();
        await expect(fs.readFile(mediaPath as string)).resolves.toEqual(attachment);
      },
    );
  });

  it("reports a missing workspace file without exposing the draft", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-error-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const media = path.join(state.workspaceDir, "missing.txt");
        const tool = createCurrentSourceMessageTool({ workspaceDir: state.workspaceDir });

        await expect(
          tool.execute("message-path-error", {
            action: "send",
            message: "Private draft that must not enter the error.",
            attachments: [{ media, type: "file", name: "missing.txt" }],
            final: true,
          }),
        ).rejects.toThrow(
          new Error(
            "Current-source media could not be staged.\n⚠️ missing.txt: File not found. Check the path and try again.",
          ),
        );
      },
    );
  });

  it("uses policy-scoped bridge access for remote-only current-source media", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-remote-media-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const remoteWorkspaceDir = state.path("remote-workspace");
        await fs.mkdir(remoteWorkspaceDir, { recursive: true });
        await fs.writeFile(path.join(remoteWorkspaceDir, "proof.txt"), "remote proof");
        const sandbox = createSandboxTestContext({
          overrides: {
            backendId: "test",
            workspaceDir: state.workspaceDir,
            agentWorkspaceDir: state.workspaceDir,
            containerWorkdir: "/sandbox",
          },
        });
        const sandboxFsBridge = createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: {
            remoteWorkspaceDir,
            remoteAgentWorkspaceDir: remoteWorkspaceDir,
            runRemoteShellScript: createLocalRemoteShellScriptRunner(),
          },
        });
        const bridgeReadFile = vi.spyOn(sandboxFsBridge, "readFile");
        const tool = createCurrentSourceMessageTool({
          workspaceDir: state.workspaceDir,
          sandboxContainerWorkdir: "/sandbox",
          sandboxFsBridge,
          sandboxWorkspaceMediaReadAllowed: true,
        });

        const toolResult = await tool.execute("message-remote-media-call", {
          action: "send",
          message: "Attached proof.",
          media: "/sandbox/proof.txt",
        });

        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply?.mediaUrls).toHaveLength(1);
        await expect(fs.readFile(sourceReply?.mediaUrls?.[0] as string, "utf8")).resolves.toBe(
          "remote proof",
        );

        bridgeReadFile.mockClear();
        const deniedTool = createCurrentSourceMessageTool({
          workspaceDir: state.workspaceDir,
          sandboxContainerWorkdir: "/sandbox",
          sandboxFsBridge,
          sandboxWorkspaceMediaReadAllowed: false,
        });
        await expect(
          deniedTool.execute("message-remote-media-denied", {
            action: "send",
            message: "Attached proof.",
            media: "/sandbox/proof.txt",
          }),
        ).rejects.toThrow(/could not be staged|outside workspace root/i);
        expect(bridgeReadFile).not.toHaveBeenCalled();
      },
    );
  });

  it("publishes managed media with aligned metadata and the current run owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-internal-source-reply-" },
      async (state) => {
        const { stateDir, workspaceDir } = state;
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const sessionKey = "agent:main:webchat:dm:restart-proof";
        const sessionId = "restart-proof-session";
        const imagePaths = ["first.png", "second.png"].map((name) => path.join(workspaceDir, name));
        const documentPath = path.join(workspaceDir, "report.json");
        const documentName = "Quarterly report.json";
        await fs.mkdir(workspaceDir, { recursive: true });
        await Promise.all(
          imagePaths.map((imagePath) =>
            fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64")),
          ),
        );
        await fs.writeFile(documentPath, '{"status":"ready"}\n');

        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { sessionId, chatType: "direct", updatedAt: 1 },
        );
        const config = {
          agents: { entries: { main: { workspace: workspaceDir } } },
        };
        const tool = createCurrentSourceMessageTool({
          config,
          sourceReplyDeliveryMode: undefined,
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          sessionId,
          agentId: "main",
          runId: "restart-proof-run",
        });

        const sendParams = {
          action: "send" as const,
          message: "Durable image reply",
          mediaUrls: [...imagePaths, documentPath],
          attachments: [{ media: documentPath, name: documentName, mimeType: "application/json" }],
        };
        const updates: SessionTranscriptUpdate[] = [];
        const publishedDownloads: Array<Promise<unknown>> = [];
        const download = (artifactId: unknown) =>
          resolveManagedOutgoingMediaArtifactDownload({
            sessionKey,
            agentId: "main",
            artifactId: String(artifactId),
            stateDir,
          });
        const unsubscribe = onSessionTranscriptUpdate((update) => {
          updates.push(update);
          for (const block of readAssistantDisplayContent(update.message).filter(
            (entry) => entry.type === "image",
          )) {
            publishedDownloads.push(download(block.artifactId));
          }
        });
        const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
        let preCommitCleanup:
          | Awaited<ReturnType<typeof cleanupManagedOutgoingMediaRecords>>
          | undefined;
        const appendSpy = vi
          .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
          .mockImplementationOnce(async (params) => {
            preCommitCleanup = await cleanupManagedOutgoingMediaRecords({ stateDir });
            return append(params);
          });
        const [toolResult, overlappingResult] = await Promise.all([
          tool.execute("restart-proof-call", sendParams),
          tool.execute("restart-proof-call", sendParams),
        ]).finally(() => {
          unsubscribe();
          appendSpy.mockRestore();
        });
        expect(preCommitCleanup).toEqual({
          deletedRecordCount: 0,
          deletedFileCount: 0,
          retainedCount: 3,
        });
        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply).toMatchObject({ transcriptOwner: true });
        expect(overlappingResult.details).toMatchObject({
          idempotencyKey: sourceReply?.idempotencyKey,
          sourceReplyTranscriptOwner: true,
        });
        const sourcePayloads = buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAssistant: undefined,
          sessionKey,
          agentId: "main",
          sourceReplyDeliveryMode: "message_tool_only",
          messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
          runId: "restart-proof-run",
          verboseLevel: "off",
          reasoningLevel: "off",
          toolResultFormat: "plain",
        });
        expect(sourcePayloads[0]).toMatchObject({
          attachments: [
            expect.objectContaining({ name: "first.png", trustedLocalMedia: true }),
            expect.objectContaining({ name: "second.png", trustedLocalMedia: true }),
            expect.objectContaining({
              name: documentName,
              mimeType: "application/json",
              trustedLocalMedia: true,
            }),
          ],
          trustedLocalMedia: true,
        });
        const mirror = getReplyPayloadMetadata(
          sourcePayloads[0] as object,
        )?.sourceReplyTranscriptMirror;
        expect(mirror).toMatchObject({ transcriptOwner: true });
        await mirrorDeliveredReplyToTranscript({
          metadata: mirror ? { ...mirror, expectedSessionId: sessionId, storePath } : undefined,
          cfg: config,
        });
        const events = await loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath,
        });
        const assistants = events
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(assistants).toHaveLength(1);
        const assistant = assistants[0];
        const displayContent = readAssistantDisplayContent(assistant);
        const image = displayContent.find((block) => block.type === "image");
        const document = displayContent.find((block) => block.type === "attachment");
        expect(toolResult.details).toMatchObject({
          sourceReplySink: "internal-ui",
          idempotencyKey: expect.any(String),
        });
        expect(assistant?.content).toEqual([{ type: "text", text: "Durable image reply" }]);
        expect(image).toMatchObject({
          type: "image",
          artifactId: expect.stringMatching(/^artifact_managed_image_/u),
        });
        expect(displayContent.filter((block) => block.type === "image")).toHaveLength(2);
        expect(document).toMatchObject({
          type: "attachment",
          attachment: {
            artifactId: expect.stringMatching(/^artifact_managed_media_/u),
            kind: "document",
            label: documentName,
            mimeType: "application/json",
          },
        });
        expect(JSON.stringify(assistant)).not.toContain(workspaceDir);
        expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toHaveLength(3);
        const published = updates.find(
          (update) =>
            update.runId === "restart-proof-run" &&
            asOptionalRecord(update.message)?.role === "assistant",
        );
        expect(published).toMatchObject({
          runId: "restart-proof-run",
          target: { agentId: "main", sessionId, sessionKey },
        });
        expect(asOptionalRecord(published?.message)?.content).toEqual(assistant?.content);
        expect(asOptionalRecord(published?.message)?.openclawDisplayContent).toEqual(
          displayContent,
        );
        await expect(Promise.all(publishedDownloads)).resolves.toEqual([
          expect.objectContaining({ type: "image" }),
          expect.objectContaining({ type: "image" }),
        ]);
        for (const block of displayContent.filter((entry) => entry.type === "image")) {
          await expect(download(block.artifactId)).resolves.toMatchObject({ type: "image" });
        }
        await expect(
          download(asOptionalRecord(document?.attachment)?.artifactId),
        ).resolves.toMatchObject({ type: "file", title: documentName });
      },
    );
  });

  it.each(["conflicting-writer", "lifecycle-drain-failure"] as const)(
    "cleans only uncommitted source-reply originals when append %s",
    async (outcome) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "source-reply-append-outcome-" },
        async (state) => {
          const sessionKey = "agent:main:webchat:dm:append-outcome";
          const sessionId = "append-outcome-session";
          const storePath = path.join(
            state.stateDir,
            "agents",
            "main",
            "sessions",
            "sessions.json",
          );
          const scope = { agentId: "main", sessionKey, sessionId, storePath };
          const imagePath = path.join(state.workspaceDir, "proof.png");
          await fs.mkdir(state.workspaceDir, { recursive: true });
          await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
          await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
          const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
          const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ sessionId });
          const preparedOriginals: string[] = [];
          const appendSpy = vi
            .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
            .mockImplementationOnce(async (params) => {
              for (const { record } of await listManagedImageRecordEntries({
                stateDir: state.stateDir,
                sessionKey,
              })) {
                preparedOriginals.push(
                  path.join(
                    record.original.mediaRoot,
                    record.original.mediaSubdir,
                    record.original.mediaId,
                  ),
                );
              }
              if (outcome === "conflicting-writer") {
                // Another writer wins after the source-reply owner's initial lookup.
                await append({
                  ...params,
                  eventId: "winning-message",
                  content: [{ type: "text", text: "Already delivered" }],
                  onMessageCommitted: undefined,
                });
              }
              return append(params);
            });
          try {
            const persist = () =>
              persistInternalSourceReply({
                cfg: {
                  agents: { entries: { main: { workspace: state.workspaceDir } } },
                },
                sessionKey,
                expectedSessionId: sessionId,
                agentId: "main",
                idempotencyKey: "append-outcome-reply",
                sourceReplyFinal: true,
                payload: {
                  text: "Attached proof",
                  mediaUrls: [imagePath],
                  trustedLocalMedia: true,
                },
              });
            const persistence =
              outcome === "lifecycle-drain-failure"
                ? withOwnedSessionTranscriptWrites(
                    {
                      sessionKey,
                      sessionTarget: scope,
                      withTranscriptWrite: (run) =>
                        lifecycle.withTranscriptWrite(async () => {
                          const result = await run();
                          // This is an actual nested lifecycle failure after the transcript commits.
                          void lifecycle
                            .withTranscriptWrite(() => {
                              throw new Error("nested drain failed");
                            })
                            .catch(() => {});
                          return result;
                        }),
                    },
                    persist,
                  )
                : persist();
            await expect(persistence).rejects.toThrow(
              outcome === "conflicting-writer"
                ? "conflicts with the admitted message"
                : "nested drain failed",
            );
          } finally {
            appendSpy.mockRestore();
            await lifecycle.dispose();
          }
          expect(preparedOriginals).toHaveLength(1);
          const committed = outcome === "lifecycle-drain-failure";
          const records = await listManagedImageRecordEntries({
            stateDir: state.stateDir,
            sessionKey,
          });
          expect(records).toHaveLength(committed ? 1 : 0);
          for (const original of preparedOriginals) {
            if (committed) {
              await expect(fs.readFile(original)).resolves.toEqual(
                Buffer.from(TINY_PNG_BASE64, "base64"),
              );
            } else {
              await expect(fs.stat(original)).rejects.toMatchObject({ code: "ENOENT" });
            }
          }
          const assistants = (await loadTranscriptEvents(scope)).filter(
            (event) => readTranscriptEventMessage(event)?.role === "assistant",
          );
          expect(assistants).toHaveLength(1);
          if (committed) {
            expect(records[0]?.record).toMatchObject({
              messageId: readTranscriptEventId(assistants[0]),
              retentionClass: "history",
            });
            await expect(
              resolveManagedOutgoingMediaArtifactDownload({
                sessionKey,
                agentId: "main",
                stateDir: state.stateDir,
                artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${records[0]?.record.attachmentId}`,
              }),
            ).resolves.toMatchObject({ type: "image" });
          }
          if (outcome === "conflicting-writer") {
            expect(assistants[0]).toMatchObject({
              id: "winning-message",
              message: { content: [{ type: "text", text: "Already delivered" }] },
            });
          }
        },
      );
    },
  );
});

for (const entry of ["tool", "rpc"] as const) {
  it(`binds real cron authority through the ${entry} entry before deferred provider initiation`, async ({
    signal,
  }) => {
    const registry = captureActivePluginRegistrySnapshot();
    const state = await createOpenClawTestState();
    const entered = createDeferred();
    const resume = createDeferred();
    const provider = vi.fn(async () => new Response("accepted"));
    let pending: Promise<unknown> | undefined;
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
      tools: { allow: ["message"] },
      channels: { discord: { token: "synthetic-token" } },
    };
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "discord" }),
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          const result = await fetchWithSsrFGuard({
            url: "https://public.example/message",
            fetchImpl: provider,
            lookupFn: async () => {
              entered.resolve();
              await resume.promise;
              return [{ address: "93.184.216.34", family: 4 }];
            },
          });
          await result.release();
          return { channel: "discord", messageId: "must-not-be-sent" };
        },
      },
    };
    try {
      setRuntimeConfigSnapshot(cfg, cfg);
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );
      await withCronMessageRun(
        {
          cfg,
          storePath: state.statePath("cron", "entrypoint.json"),
          sessionKey: "agent:main:cron:message-entrypoint:run:proof",
          sessionId: "message-entrypoint-session",
        },
        async (owner) => {
          const respond = vi.fn();
          if (entry === "tool") {
            pending = owner.createTool().execute("entrypoint-send", {
              action: "send",
              channel: "discord",
              target: "channel:100000000000000001",
              message: "private draft",
            });
          } else {
            const { sendHandlers } = await import("../../gateway/server-methods/send.js");
            const token = owner.messageActionTurnCapability;
            const messageActionContext = expectDefined(
              resolveMessageActionTurnCapability({
                token,
                agentId: "main",
                runId: owner.runId,
                sessionKey: owner.sessionKey,
                sessionId: owner.sessionId,
              }),
              "real cron turn context",
            );
            const authority = expectDefined(
              getAdmittedRunDelegatedAuthority(owner.admitted),
              "real cron admission",
            );
            const client = createSyntheticPluginRuntimeClient();
            client.internal = {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: owner.sessionKey,
                operationalRunInstance: owner.admitted.operationalRunInstance,
                delegatedAuthority: { ...authority, kind: "local" },
                messageActionContext: { ...messageActionContext, turnCapability: token },
              },
            };
            pending = Promise.resolve(
              sendHandlers.send!({
                req: { type: "req", id: "entrypoint-send", method: "send" },
                params: {
                  channel: "discord",
                  to: "channel:100000000000000001",
                  message: "private draft",
                  sessionKey: owner.sessionKey,
                  idempotencyKey: "entrypoint-send",
                },
                client,
                respond,
                isWebchatConnect: () => false,
                context: {
                  getRuntimeConfig: () => cfg,
                  dedupe: new Map(),
                  validateAgentRuntimeApprovalAuthority:
                    createAgentRuntimeApprovalAuthorityValidator(),
                } as GatewayRequestContext,
              }),
            );
          }
          void pending.catch(() => undefined);
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "Message missed provider preparation",
            ),
            signal,
          );
          await withinTest(owner.revokeMessage(), signal);
          resume.resolve();
          if (entry === "tool") {
            await expect(pending).rejects.toThrow(/authority|active/i);
          } else {
            await withinTest(pending, signal);
            expect(respond).toHaveBeenCalledOnce();
            expect(respond.mock.calls[0]?.[0]).toBe(false);
          }
          expect(provider).not.toHaveBeenCalled();
        },
      );
    } finally {
      resume.resolve();
      await pending?.catch(() => undefined);
      restoreActivePluginRegistrySnapshot(registry);
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });
}
