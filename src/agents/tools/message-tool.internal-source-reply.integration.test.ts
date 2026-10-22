// Integration coverage for real cron message authority and targetless WebChat
// replies through the internal source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { mirrorDeliveredReplyToTranscript } from "../../auto-reply/reply/dispatch-from-config.transcript.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
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
import { resolveAgentRestartRecoveryContext } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { persistInternalSourceReply } from "../../gateway/internal-source-reply-persistence.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { buildRestartSafeChatTranscriptState } from "../../gateway/server-methods/chat-restart-recovery.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
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
  const options: NonNullable<Parameters<typeof createMessageTool>[0]> = {
    config: { agents: { entries: { main: {} } } },
    preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
    currentChannelProvider: "webchat",
    sourceReplyDeliveryMode: "automatic",
    agentSessionKey: "agent:main:webchat:dm:dashboard",
    runId: "webchat-run",
    sandboxRoot: params.sandboxFsBridge ? params.workspaceDir : undefined,
    ...params,
  };
  setRuntimeConfigSnapshot(options.config ?? {});
  return createMessageTool(options);
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("WebChat message tool internal source reply", () => {
  it.each([
    { sessionKey: "agent:main:dashboard:recovered-cli", delivers: true },
    { sessionKey: "agent:main:webchat:dm:recovered-cli", delivers: true },
    { sessionKey: "agent:main:telegram:direct:123", delivers: false },
  ])(
    "keeps targetless recovered CLI progress internal for $sessionKey",
    async ({ sessionKey, delivers }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "recovered-cli-source-" },
        async (state) => {
          const sessionId = "recovered-cli-session";
          const runId = "recovery-run";
          const storePath = path.join(
            state.stateDir,
            "agents",
            "main",
            "sessions",
            "sessions.json",
          );
          const scope = { agentId: "main", sessionKey, sessionId, storePath };
          const { sessionLifecyclePatch } = buildRestartSafeChatTranscriptState({
            admission: { requestFingerprint: "cli-chat-request" },
            clientRunId: "interrupted-cli-run",
            startedAt: 1,
            sourceIngress: "internal",
          });
          const entry = {
            ...sessionLifecyclePatch,
            sessionId,
            updatedAt: 2,
            restartRecoveryDeliveryRunId: runId,
          };
          await replaceSessionEntry(scope, entry);
          const recovery = resolveAgentRestartRecoveryContext({
            isRestartRecoveryResumeRun: true,
            canUseInternalRuntimeHandoff: true,
            expectedExistingSessionId: sessionId,
            resolvedSessionId: sessionId,
            resolvedSessionKey: sessionKey,
            runId,
            sessionEntry: entry,
          });
          expect(recovery?.pinnedWidgetAuthoring).toBeUndefined();
          const tool = createCurrentSourceMessageTool({
            agentSessionKey: sessionKey,
            runSessionKey: sessionKey,
            sessionId,
            agentId: "main",
            runId,
            currentChannelProvider: recovery?.messageChannel,
          });
          const send = tool.execute("recovered-progress", {
            action: "send",
            message: "Still working after restart.",
            final: false,
          });
          if (!delivers) {
            await expect(send).rejects.toThrow("Action send requires a target.");
            expect(await loadTranscriptEvents(scope)).toEqual([]);
            return;
          }
          const result = await send;
          expect(result.details).toMatchObject({
            sourceReplySink: "internal-ui",
            sourceReplyTranscriptOwner: true,
          });
          const assistants = (await loadTranscriptEvents(scope))
            .map(readTranscriptEventMessage)
            .filter((message) => message?.role === "assistant");
          expect(assistants).toHaveLength(1);
          expect(assistants[0]?.content).toEqual([
            { type: "text", text: "Still working after restart." },
          ]);
          expect(assistants[0]).toMatchObject({
            __openclaw: { runId },
            openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
          });
        },
      );
    },
  );

  it("refuses an internal-source transcript commit after its real cron admission closes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-source-commit-" },
      async (state) => {
        setRuntimeConfigSnapshot({});
        const sessionKey = "agent:main:webchat:dm:cron-source-commit";
        const sessionId = "cron-source-commit-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        const cfg = {
          agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
          tools: { allow: ["message"] },
        };
        setRuntimeConfigSnapshot(cfg);
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        await withCronMessageRun(
          {
            cfg,
            storePath: state.statePath("cron", "internal-source.json"),
            sessionKey,
            sessionId,
          },
          async (owner) => {
            const message = "must never become a committed assistant message";
            let commitRequests = 0;
            const admission = probe.admission(operationAdmission, (request, grant, admit) => {
              if (
                request.stage === "commit" &&
                isRecord(request.facts) &&
                isRecord(request.facts.publication) &&
                request.facts.publication.kind === "session-entry-patch-committed"
              ) {
                commitRequests += 1;
                owner.closeAdmission();
              }
              admit(request, grant);
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
              expect({ commitRequests, assistants }).toEqual({
                commitRequests: 1,
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

  it("downloads and persists scheduled current-source media once", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-source-remote-media-" },
      async (state) => {
        setRuntimeConfigSnapshot({});
        const sessionKey = "agent:main:webchat:dm:cron-source-media";
        const sessionId = "cron-source-media-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        const cfg = {
          agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
          tools: { allow: ["message"] },
        };
        setRuntimeConfigSnapshot(cfg);
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        await withCronMessageRun(
          {
            cfg,
            storePath: state.statePath("cron", "internal-source-media.json"),
            sessionKey,
            sessionId,
          },
          async (owner) => {
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
            }
          },
        );
      },
    );
  });

  it.each([true, false])(
    "projects a targetless send and preserves automatic final text only for progress (final=%s)",
    async (final) => {
      const tool = createCurrentSourceMessageTool();

      const toolResult = await tool.execute("message-call", {
        action: "send",
        message: "Visible progress from the message tool.",
        final,
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
      const delivery = readEmbeddedMessageDeliveryFact(
        asOptionalRecord(toolResult.details)?.messageDelivery,
      );
      expect(delivery?.sourceReplyDelivered === true).toBe(final);

      const embeddedPayloads = buildEmbeddedRunPayloads({
        assistantTexts: ["Visible automatic final reply."],
        lastAssistant: undefined,
        currentAssistant: undefined,
        sessionKey: "agent:main:webchat:dm:dashboard",
        sourceReplyDeliveryMode: "automatic",
        didDeliverSourceReplyViaMessageTool: delivery?.sourceReplyDelivered,
        messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
        runId: "webchat-run",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "plain",
      });
      const { replyPayloads: payloads } = await buildReplyPayloads({
        payloads: embeddedPayloads,
        isHeartbeat: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "off",
        messagingToolSentTexts: ["Visible progress from the message tool."],
      });

      expect(payloads.map((payload) => payload.text)).toEqual(
        final
          ? ["Visible progress from the message tool."]
          : ["Visible progress from the message tool.", "Visible automatic final reply."],
      );
      expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:webchat:dm:dashboard",
          text: "Visible progress from the message tool.",
          idempotencyKey: "webchat-run:internal-source-reply:0",
        },
      });
      if (!final) {
        expect(getReplyPayloadMetadata(payloads[1] as object)?.sourceReplyTranscriptMirror).toBe(
          undefined,
        );
      }
    },
  );

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
        setRuntimeConfigSnapshot({});
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

  it("publishes the final workspace HTML as a durable attachment without granting automatic publication", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-html-" },
      async (state) => {
        const { stateDir, workspaceDir } = state;
        const sessionKey = "agent:main:webchat:dm:html-report";
        const sessionId = "html-report-session";
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        const config = {
          agents: { entries: { main: { workspace: workspaceDir } } },
          tools: { profile: "full" as const },
        };
        await fs.mkdir(workspaceDir, { recursive: true });
        const report = path.join(workspaceDir, "implementation-plan.html");
        await fs.writeFile(report, "<!doctype html><h1>Child draft</h1>");
        const finalBytes = Buffer.from(
          "<!doctype html><title>Plan</title><h1>Parent revision</h1>",
        );
        await fs.writeFile(report, finalBytes);
        await replaceSessionEntry(scope, { sessionId, chatType: "direct", updatedAt: 1 });
        setRuntimeConfigSnapshot(config);

        const automatic = await createReplyMediaPathNormalizer({
          cfg: config,
          sessionKey,
          workspaceDir,
        })({ mediaUrl: report });
        expect(automatic.mediaUrl).toBeUndefined();
        expect(getReplyPayloadMetadata(automatic)?.assistantMediaFailures).toEqual([
          expect.objectContaining({ code: "unsupported-format" }),
        ]);

        const tool = createCurrentSourceMessageTool({
          config,
          workspaceDir,
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          sessionId,
          agentId: "main",
        });
        await tool.execute("publish-html-report", {
          action: "send",
          message: "Implementation plan attached.",
          media: report,
        });
        // Reload the persisted display record after the mutable source has disappeared.
        await fs.rm(report);
        const assistants = (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(assistants).toHaveLength(1);
        const display = readAssistantDisplayContent(assistants[0]);
        const attachment = display.find((block) => block.type === "attachment");
        expect(attachment).toMatchObject({
          type: "attachment",
          attachment: { label: "implementation-plan.html", mimeType: "text/html" },
        });
        expect(display.some((block) => block.type === "attachment_error")).toBe(false);
        const artifactId = asOptionalRecord(attachment?.attachment)?.artifactId;
        expect(artifactId).toEqual(expect.any(String));
        await expect(
          resolveManagedOutgoingMediaArtifactDownload({
            sessionKey,
            agentId: "main",
            artifactId: String(artifactId),
            stateDir,
          }),
        ).resolves.toMatchObject({ type: "file", title: "implementation-plan.html" });
        const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
        expect(records).toHaveLength(1);
        const original = records[0]!.record.original;
        const originalPath = path.join(original.mediaRoot, original.mediaSubdir, original.mediaId);
        await expect(fs.readFile(originalPath)).resolves.toEqual(finalBytes);
      },
    );
  });

  it("reports a missing workspace file without exposing the draft", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-error-" },
      async (state) => {
        setRuntimeConfigSnapshot({});
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
        setRuntimeConfigSnapshot({});
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const remoteWorkspaceDir = state.path("remote-workspace");
        await fs.mkdir(remoteWorkspaceDir, { recursive: true });
        const html = "<!doctype html><h1>Remote proof</h1>";
        await fs.writeFile(path.join(remoteWorkspaceDir, "proof.html"), html);
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
          media: "/sandbox/proof.html",
        });

        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply?.mediaUrls).toHaveLength(1);
        await expect(fs.readFile(sourceReply?.mediaUrls?.[0] as string, "utf8")).resolves.toBe(
          html,
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
            media: "/sandbox/proof.html",
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
        setRuntimeConfigSnapshot({});
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
        let preCommitEntries: Awaited<ReturnType<typeof listManagedImageRecordEntries>> = [];
        const appendSpy = vi
          .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
          .mockImplementationOnce(async (params) => {
            await cleanupManagedOutgoingMediaRecords({ stateDir });
            preCommitEntries = await listManagedImageRecordEntries({ stateDir, sessionKey });
            for (const { record } of preCommitEntries) {
              const { mediaRoot, mediaSubdir, mediaId, contentType } = record.original;
              expect(await fs.readFile(path.join(mediaRoot, mediaSubdir, mediaId))).toEqual(
                contentType === "image/png"
                  ? Buffer.from(TINY_PNG_BASE64, "base64")
                  : Buffer.from('{"status":"ready"}\n'),
              );
            }
            return append(params);
          });
        const [toolResult, overlappingResult] = await Promise.all([
          tool.execute("restart-proof-call", sendParams),
          tool.execute("restart-proof-call", sendParams),
        ]).finally(() => {
          unsubscribe();
          appendSpy.mockRestore();
        });
        expect(preCommitEntries).toHaveLength(3);
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
          setRuntimeConfigSnapshot({});
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
          const cfg = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
          };
          setRuntimeConfigSnapshot(cfg);
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
                cfg,
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
