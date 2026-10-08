import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { observeParentSqlite } from "../../../test/helpers/sqlite-parent-observer.js";
import { makeRunAgentAttemptParams } from "../../agents/command/attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "../../agents/command/attempt-execution.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage } from "../../llm/types.js";
import * as hookRunnerGlobal from "../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveManagedImageOriginalPath } from "../managed-image-attachments.custody.js";
import { resolveManagedOutgoingMediaArtifactDownload } from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import * as replyMedia from "../server-methods/chat-reply-media.js";
import * as transcriptMedia from "../server-methods/chat-transcript-persistence.js";
import { loadSessionEntry } from "../session-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import { dispatchAgentRunWithMedia } from "./agent-run-media.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));
// mock-isolation: Skip command admission while retaining real attempt forwarding below.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));
// mock-isolation: Replace model execution while preserving real dispatch and transcript custody.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.embedded }));

afterEach(() => vi.restoreAllMocks());

async function runMediaTurn(
  state: OpenClawTestState,
  authoredMessage: AssistantMessage,
  final?: {
    payloads: ReplyPayload[];
    options?: Partial<AgentCommandGatewayIngressOpts>;
    incognito?: boolean;
    changeAfterPreparation?: "abort" | "permission" | "placement" | "route";
    abortAfterCommit?: boolean;
    retargetBeforeNormalization?: boolean;
  },
) {
  const { runId, sessionKey, entry, context } = createTrackedDispatch();
  const sessionId = entry.sessionId;
  const logicalStore = final?.retargetBeforeNormalization
    ? state.statePath("media-session.json")
    : undefined;
  const cfg: OpenClawConfig = {
    ...(logicalStore ? { session: { store: logicalStore } } : {}),
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      ...(logicalStore
        ? {
            defaults: {
              sandbox: {
                mode: "off",
                workspaceAccess: "none",
                workspaceRoot: state.statePath("sandboxes"),
              },
            },
          }
        : {}),
    },
    plugins: { enabled: false },
  };
  await state.writeConfig(cfg);
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: logicalStore ?? loadSessionEntry(sessionKey, { agentId: "main" }).storePath,
  };
  const transcriptScope = {
    ...scope,
    storePath: logicalStore ? state.statePath("media-session.main.sqlite") : scope.storePath,
  };
  const sessionEntry = { sessionId, lifecycleRevision: "initial", updatedAt: 1 };
  await replaceSessionEntry(transcriptScope, sessionEntry);
  // Admit the shared media store before entering the run-owned transcript context.
  expect(await listManagedImageRecordEntries({ sessionKey })).toEqual([]);
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ runId, sessionId });
  let finalizationStatements = 0;
  const placements =
    final?.changeAfterPreparation === "placement" ? createWorkerSessionPlacementStore() : undefined;
  if (final?.retargetBeforeNormalization) {
    const prepare = replyMedia.prepareWebchatReplyMediaForDisplay;
    vi.spyOn(replyMedia, "prepareWebchatReplyMediaForDisplay").mockImplementationOnce(
      async (params) => {
        await replaceSessionEntry(
          { ...scope, storePath: state.statePath("media-session.sqlite") },
          { ...sessionEntry, sandbox: "required" },
        );
        return prepare(params);
      },
    );
  }
  if (final?.changeAfterPreparation) {
    const prepare = replyMedia.prepareWebchatReplyMediaForDisplay;
    vi.spyOn(replyMedia, "prepareWebchatReplyMediaForDisplay").mockImplementationOnce(
      async (params) => {
        const prepared = await prepare(params);
        if (final.changeAfterPreparation === "abort") {
          entry.controller.abort();
        } else if (placements) {
          await placements.startDispatch({
            agentId: "main",
            sessionKey,
            sessionId,
            executionMode: "worker-turn",
          });
        } else {
          await patchSessionEntryCore(scope, () =>
            final.changeAfterPreparation === "permission"
              ? { permissionMode: "workspace" }
              : {
                  delivery: normalizeSessionDeliveryState({
                    context: { channel: "telegram", to: "new-peer" },
                  }),
                  totalTokens: 42,
                },
          );
        }
        return prepared;
      },
    );
  }
  if (final?.abortAfterCommit) {
    const enrich = transcriptMedia.enrichAssistantTranscriptMediaForRun;
    vi.spyOn(transcriptMedia, "enrichAssistantTranscriptMediaForRun").mockImplementationOnce(
      async (params) => {
        const rewritten = await enrich(params);
        entry.controller.abort();
        return rewritten;
      },
    );
  }
  mocks.command.mockImplementationOnce(async (options) => {
    const result = await runAgentAttempt(
      makeRunAgentAttemptParams({
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        cfg,
        sessionEntry,
        sessionKey,
        sessionTarget: scope,
        storePath: scope.storePath,
        runId,
        agentHarnessRuntimeOverride: "openclaw",
        pluginsEnabled: false,
        opts: options,
      }),
    );
    const statements = observeParentSqlite();
    try {
      await options.beforeTerminalDelivery?.({
        payloads: final?.payloads ?? [],
        sessionId,
        lifecycleRevision: sessionEntry.lifecycleRevision,
        storePath: scope.storePath,
      });
    } finally {
      finalizationStatements += Object.values(statements.counts).reduce(
        (total, count) => total + count,
        0,
      );
      statements.restore();
    }
    return { payloads: [], meta: result.meta };
  });
  mocks.embedded.mockImplementationOnce(async (options) => {
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed: () => entry.controller.signal.throwIfAborted(),
          withTranscriptWrite: (operation) => lifecycle.withTranscriptWrite(operation),
        },
        async () => {
          const message = runAgentHarnessBeforeMessageWriteHook({
            message: attachSessionTranscriptRunId(authoredMessage, runId),
            prepareAssistantTranscriptMessage: options.prepareAssistantTranscriptMessage,
          });
          if (!message) {
            throw new Error("Expected a commentary message");
          }
          const append = appendTranscriptMessageSync(scope, { eventId: "progress", message });
          expect(append).toMatchObject({ ok: true });
          await publishTranscriptUpdate(scope, { message, messageId: "progress", runId });
        },
      );
    } finally {
      await lifecycle.dispose();
    }
    return { payloads: [], meta: { durationMs: 0 } };
  });
  const readMessage = () =>
    asOptionalRecord(
      loadTranscriptEventsSync(transcriptScope)
        .map(asOptionalRecord)
        .find((candidate) => candidate?.type === "message" && candidate.id === "progress")?.message,
    );
  let messageAtFinal: Record<string, unknown> | undefined;
  const result = await dispatchAgentRunWithMedia(
    {
      admittedRunEntry: entry,
      ingressOpts: {
        message: "Show progress",
        sessionKey,
        sessionId,
        abortSignal: entry.controller.signal,
        allowModelOverride: false,
        channel: "webchat",
        ...final?.options,
      },
      runId,
      dedupeKeys: [],
      abortController: entry.controller,
      cleanupAbortController: () => {
        context.chatAbortControllers.delete(runId);
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: () => {
          messageAtFinal = readMessage();
        },
      },
      context,
      isIncognito: final?.incognito,
    },
    { cfg, client: null, activeSessionAgentId: "main" },
  );
  return {
    result,
    context,
    sessionKey,
    message: readMessage(),
    messageAtFinal,
    finalizationStatements,
    retargetedEntry: logicalStore
      ? loadSessionEntry(sessionKey, { agentId: "main" }).entry
      : undefined,
  };
}

it("preserves agent-run commentary attachments after their source files are removed", async () => {
  await withOpenClawTestState({ label: "agent-commentary-media" }, async (state) => {
    const imagePath = path.join(state.workspaceDir, "before.png");
    const hookImagePath = path.join(state.workspaceDir, "hook-added.png");
    const png = createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await Promise.all([imagePath, hookImagePath].map((file) => fs.writeFile(file, png)));
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
      createHookRunnerWithRegistry([
        {
          hookName: "before_message_write",
          handler: (event: unknown) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            const first = Array.isArray(message?.content)
              ? asOptionalRecord(message.content[0])
              : undefined;
            if (first?.type === "text" && typeof first.text === "string") {
              first.text += `\nMEDIA:${hookImagePath}`;
            }
          },
        },
      ]).runner,
    );
    const { result, context, sessionKey, message } = await runMediaTurn(
      state,
      makeAgentAssistantMessage({
        content: [
          {
            type: "text",
            text: `Before\nMEDIA:${imagePath}`,
            textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
          },
          { type: "toolCall", id: "next", name: "read", arguments: { path: "next.ts" } },
        ],
        stopReason: "toolUse",
      }),
    );
    expect(result.terminalOutcome.status).toBe("ok");
    expect(context.logGateway.warn).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      stopReason: "toolUse",
      openclawDelivery: { mediaUrls: [imagePath] },
      openclawDisplayContent: expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          url: expect.stringContaining("/api/chat/media/outgoing/"),
          artifactId: expect.any(String),
        }),
        expect.objectContaining({ type: "text", text: `MEDIA:${hookImagePath}` }),
      ]),
    });
    const displayed = Array.isArray(message?.openclawDisplayContent)
      ? message.openclawDisplayContent.map(asOptionalRecord)
      : [];
    const image = displayed.find((block) => block?.type === "image");
    if (typeof image?.artifactId !== "string") {
      throw new Error("Expected a managed commentary artifact");
    }
    await Promise.all([imagePath, hookImagePath].map((file) => fs.unlink(file)));
    await expect(
      resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        agentId: "main",
        artifactId: image.artifactId,
      }),
    ).resolves.toMatchObject({
      artifactId: image.artifactId,
      mimeType: "image/png",
      sizeBytes: png.length,
    });
    const records = await listManagedImageRecordEntries({ sessionKey });
    expect(records).toHaveLength(1);
    const record = records[0]?.record;
    assert(record);
    expect(await fs.readFile(resolveManagedImageOriginalPath(record))).toEqual(png);
  });
});

it.each(["raw directive", "structured attachment", "separate text payload"] as const)(
  "owns the agent-run final %s before publishing completion",
  async (source) => {
    await withOpenClawTestState({ label: "agent-final-media" }, async (state) => {
      const imagePath = path.join(state.workspaceDir, "completed.png");
      await fs.mkdir(state.workspaceDir, { recursive: true });
      await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
      const text =
        source === "raw directive"
          ? `Completed\nMEDIA:${imagePath}`
          : source === "separate text payload"
            ? `MEDIA:${imagePath}`
            : "Completed";
      const authored = makeAgentAssistantMessage({
        content: [{ type: "text", text }],
        stopReason: "stop",
      });
      const { result, context, sessionKey, message, messageAtFinal, finalizationStatements } =
        await runMediaTurn(state, authored, {
          payloads: [
            ...(source === "separate text payload" ? [{ text: "Completed" }] : []),
            {
              text,
              ...(source === "structured attachment"
                ? {
                    mediaUrls: [imagePath],
                    attachments: [{ path: imagePath, mimeType: "image/png" }],
                  }
                : {}),
            },
          ],
        });
      expect(result.terminalOutcome.status).toBe("ok");
      expect(finalizationStatements).toBe(0);
      expect(context.logGateway.warn).not.toHaveBeenCalled();
      expect(message?.content).toEqual(authored.content);
      expect(messageAtFinal?.openclawDisplayContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Completed" }),
          expect.objectContaining({
            type: "image",
            artifactId: expect.any(String),
            url: expect.stringContaining("/api/chat/media/outgoing/"),
          }),
        ]),
      );
      const records = await listManagedImageRecordEntries({ sessionKey });
      expect(records).toHaveLength(1);
      expect(records[0]?.record.messageId).toBe("progress");
    });
  },
);

it("keeps final media under its original sandbox policy when the store alias changes", async () => {
  await withOpenClawTestState({ label: "agent-final-media-alias" }, async (state) => {
    const imagePath = path.join(state.workspaceDir, "completed.png");
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
    const text = `Completed\nMEDIA:${imagePath}`;
    const { result, context, messageAtFinal, retargetedEntry } = await runMediaTurn(
      state,
      makeAgentAssistantMessage({ content: [{ type: "text", text }], stopReason: "stop" }),
      { payloads: [{ text }], retargetBeforeNormalization: true },
    );
    expect(retargetedEntry?.sandbox).toBe("required");
    expect(result.terminalOutcome.status).toBe("ok");
    expect(context.logGateway.warn).not.toHaveBeenCalled();
    expect(messageAtFinal?.openclawDisplayContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", artifactId: expect.any(String) }),
      ]),
    );
  });
});

it.each<{
  name: string;
  options?: Partial<AgentCommandGatewayIngressOpts>;
  payload?: Partial<ReplyPayload>;
  incognito?: boolean;
}>([
  { name: "sensitive media", payload: { sensitiveMedia: true } },
  { name: "reasoning media", payload: { isReasoning: true } },
  { name: "tool-only source reply", options: { sourceReplyDeliveryMode: "message_tool_only" } },
  { name: "private completion", options: { privateCompletion: true } },
  { name: "internal session effects", options: { sessionEffects: "internal" } },
  { name: "external delivery", options: { deliver: true, channel: "telegram" } },
  { name: "queue-owned media", options: { internalDeliveryMediaUrls: [] } },
  { name: "incognito dispatch", incognito: true },
])("does not retain final $name through the WebChat projector", async (scenario) => {
  await withOpenClawTestState({ label: "agent-final-media-suppression" }, async (state) => {
    const imagePath = path.join(state.workspaceDir, "private.png");
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
    const { sessionKey, message } = await runMediaTurn(
      state,
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Completed" }],
        stopReason: "stop",
      }),
      {
        payloads: [{ text: "Completed", mediaUrls: [imagePath], ...scenario.payload }],
        options: scenario.options,
        incognito: scenario.incognito,
      },
    );
    expect(message?.openclawDisplayContent).toBeUndefined();
    expect(await listManagedImageRecordEntries({ sessionKey })).toEqual([]);
  });
});

it.each(["abort", "permission", "placement", "route"] as const)(
  "settles prepared final media after a %s change",
  async (change) => {
    await withOpenClawTestState({ label: "agent-final-media-revocation" }, async (state) => {
      const imagePath = path.join(state.workspaceDir, "revoked.png");
      await fs.mkdir(state.workspaceDir, { recursive: true });
      await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
      const { result, sessionKey, message, messageAtFinal } = await runMediaTurn(
        state,
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Completed" }],
          stopReason: "stop",
        }),
        {
          payloads: [{ text: "Completed", mediaUrls: [imagePath] }],
          changeAfterPreparation: change,
        },
      );
      expect(result.terminalOutcome.status).toBe(change === "route" ? "ok" : "error");
      if (change === "abort") {
        expect(result.terminalOutcome).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
      }
      const records = await listManagedImageRecordEntries({ sessionKey });
      if (change === "route") {
        expect(messageAtFinal?.openclawDisplayContent).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "image" })]),
        );
        expect(records).toHaveLength(1);
        expect(records[0]?.record.messageId).toBe("progress");
      } else {
        expect(message?.openclawDisplayContent).toBeUndefined();
        expect(messageAtFinal?.openclawDisplayContent).toBeUndefined();
        expect(records).toEqual([]);
      }
    });
  },
);

it("settles committed media ownership even when the run aborts before publication", async () => {
  await withOpenClawTestState({ label: "agent-final-media-committed" }, async (state) => {
    const imagePath = path.join(state.workspaceDir, "committed.png");
    const png = createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(imagePath, png);
    const { sessionKey, messageAtFinal } = await runMediaTurn(
      state,
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Completed" }],
        stopReason: "stop",
      }),
      { payloads: [{ text: "Completed", mediaUrls: [imagePath] }], abortAfterCommit: true },
    );
    expect(messageAtFinal?.openclawDisplayContent).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    const records = await listManagedImageRecordEntries({ sessionKey });
    expect(records).toHaveLength(1);
    expect(records[0]?.record.messageId).toBe("progress");
    const record = records[0]?.record;
    assert(record);
    expect(await fs.readFile(resolveManagedImageOriginalPath(record))).toEqual(png);
  });
});
