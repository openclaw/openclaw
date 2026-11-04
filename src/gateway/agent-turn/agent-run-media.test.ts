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
import { buildSourceReplyPayloadState } from "../../agents/embedded-agent-runner/run/source-reply-payloads.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
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
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
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
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import { dispatchAgentRunWithMedia } from "./agent-run-media.js";
import { testRpcSourceController } from "./rpc-source.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));
// mock-isolation: Skip command admission while retaining real attempt forwarding below.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));
// mock-isolation: Replace model execution while preserving real dispatch and transcript custody.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.embedded }));

afterEach(() => vi.restoreAllMocks());

async function writeMediaImage(state: OpenClawTestState, name: string) {
  const imagePath = path.join(state.workspaceDir, name);
  const png = createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 });
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await fs.writeFile(imagePath, png);
  return { imagePath, png };
}

const assistantText = (text = "Completed") =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });
const displayedImage = (fields: Record<string, unknown> = {}) =>
  expect.arrayContaining([expect.objectContaining({ type: "image", ...fields })]);
const managedImage = () =>
  expect.objectContaining({
    type: "image",
    url: expect.stringContaining("/api/chat/media/outgoing/"),
    artifactId: expect.any(String),
  });
const displayedText = (text: string) => expect.objectContaining({ type: "text", text });
const expectDisplay = (message: Record<string, unknown> | undefined, ...blocks: unknown[]) =>
  expect(message?.openclawDisplayContent).toEqual(expect.arrayContaining(blocks));
const withImage = (
  run: (
    state: OpenClawTestState,
    image: Awaited<ReturnType<typeof writeMediaImage>>,
  ) => Promise<void>,
) =>
  withOpenClawTestState({ label: "agent-run-media" }, async (state) =>
    run(state, await writeMediaImage(state, "image.png")),
  );

async function storedImage(sessionKey: string, png?: Buffer) {
  const records = await listManagedImageRecordEntries({ sessionKey });
  expect(records).toHaveLength(1);
  const record = records[0]?.record;
  assert(record);
  expect(record.messageId).toBe("progress");
  if (png) {
    expect(await fs.readFile(resolveManagedImageOriginalPath(record))).toEqual(png);
  }
  return record;
}

type MediaFinal = {
  payloads?: ReplyPayload[];
  committedMirror?: Record<string, unknown>;
  options?: Partial<AgentCommandGatewayIngressOpts>;
  incognito?: boolean;
  changeAfterPreparation?: "abort" | "permission" | "placement" | "route";
  abortAfterCommit?: boolean;
  retargetBeforeNormalization?: boolean;
};
const runFinalTurn = (state: OpenClawTestState, imagePath: string, final: MediaFinal = {}) =>
  runMediaTurn(state, assistantText(), {
    payloads: [{ text: "Completed", mediaUrls: [imagePath] }],
    ...final,
  });
function expectSuccess({ result, context }: Awaited<ReturnType<typeof runMediaTurn>>) {
  expect(result.terminalOutcome.status).toBe("ok");
  expect(context.logGateway.warn).not.toHaveBeenCalled();
}

async function runMediaTurn(
  state: OpenClawTestState,
  authoredMessage: AssistantMessage,
  final: MediaFinal = {},
) {
  const { runId, sessionKey, entry, context } = createTrackedDispatch();
  const sessionId = getRpcSourceIdentity(entry).sessionId;
  const controller = testRpcSourceController(entry);
  const logicalStore = final.retargetBeforeNormalization && state.statePath("media-session.json");
  const agents: NonNullable<OpenClawConfig["agents"]> = {
    entries: { main: { workspace: state.workspaceDir } },
  };
  const cfg: OpenClawConfig = {
    agents,
    plugins: { enabled: false },
  };
  if (logicalStore) {
    cfg.session = { store: logicalStore };
    agents.defaults = {
      sandbox: {
        mode: "off",
        workspaceAccess: "none",
        workspaceRoot: state.statePath("sandboxes"),
      },
    };
  }
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath:
      logicalStore || (await loadSessionEntryAsync(sessionKey, { agentId: "main" })).storePath,
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
    final.changeAfterPreparation === "placement" ? createWorkerSessionPlacementStore() : undefined;
  if (final.retargetBeforeNormalization || final.changeAfterPreparation) {
    const prepare = replyMedia.prepareWebchatReplyMediaForDisplay;
    vi.spyOn(replyMedia, "prepareWebchatReplyMediaForDisplay").mockImplementationOnce(
      async (params) => {
        if (final.retargetBeforeNormalization) {
          await replaceSessionEntry(
            { ...scope, storePath: state.statePath("media-session.sqlite") },
            { ...sessionEntry, sandbox: "required" },
          );
        }
        const prepared = await prepare(params);
        if (final.changeAfterPreparation === "abort") {
          controller.abort();
        } else if (placements) {
          await placements.startDispatch({
            agentId: "main",
            sessionKey,
            sessionId,
            executionMode: "worker-turn",
          });
        } else if (final.changeAfterPreparation) {
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
  if (final.abortAfterCommit) {
    const enrich = transcriptMedia.enrichAssistantTranscriptMediaForRun;
    vi.spyOn(transcriptMedia, "enrichAssistantTranscriptMediaForRun").mockImplementationOnce(
      async (params) => {
        const rewritten = await enrich(params);
        controller.abort();
        return rewritten;
      },
    );
  }
  mocks.command.mockImplementationOnce(async (options) => {
    const attempt = makeRunAgentAttemptParams({
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
    });
    const result = await runAgentAttempt(attempt);
    const statements = observeParentSqlite();
    try {
      await options.beforeTerminalDelivery?.({
        payloads: final.payloads ?? [],
        sessionId,
        lifecycleRevision: sessionEntry.lifecycleRevision,
        storePath: scope.storePath,
      });
    } finally {
      finalizationStatements += Object.values(statements.counts).reduce((sum, n) => sum + n, 0);
      statements.restore();
    }
    return { payloads: [], meta: result.meta };
  });
  mocks.embedded.mockImplementationOnce(async (options) => {
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed: () => entry.input.abortSignal.throwIfAborted(),
          withTranscriptWrite: (operation) => lifecycle.withTranscriptWrite(operation),
        },
        async () => {
          if (final.committedMirror) {
            expect(
              appendTranscriptMessageSync(scope, {
                eventId: "delivery-mirror",
                message: final.committedMirror,
              }),
            ).toMatchObject({ ok: true });
          }
          const message = runAgentHarnessBeforeMessageWriteHook({
            message: attachSessionTranscriptRunId(authoredMessage, runId),
            prepareAssistantTranscriptMessage: options.prepareAssistantTranscriptMessage,
          });
          assert(message, "Expected a commentary message");
          const appended = appendTranscriptMessageSync(scope, { eventId: "progress", message });
          expect(appended).toMatchObject({ ok: true });
          await publishTranscriptUpdate(scope, { message, messageId: "progress", runId });
        },
      );
    } finally {
      await lifecycle.dispose();
    }
    return { payloads: [], meta: { durationMs: 0, terminalReply: { disposition: "empty" } } };
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
        abortSignal: entry.input.abortSignal,
        allowModelOverride: false,
        channel: "webchat",
        ...final.options,
      },
      runId,
      dedupeKeys: [],
      abortController: controller,
      cleanupAbortController: () => {
        rpcSourceTesting.deleteExpected(runId, entry);
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: () => {
          messageAtFinal = readMessage();
        },
      },
      context,
      isIncognito: final.incognito,
    },
    {
      cfg,
      client: null,
      activeSessionAgentId: "main",
      prepared: {
        lifecycleStorePath: scope.storePath,
        replyDispatchRuntime: {
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config: cfg,
          modelCatalog: { entries: [], routeVariants: [] },
          inboundPluginRegistry: createEmptyPluginRegistry(),
          pluginGeneration: {
            remoteCatalog: null,
            pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
            inlineProviderModels: [],
            configuredCatalogEntries: [],
          },
        },
      },
    },
  );
  return {
    result,
    context,
    sessionKey,
    message: readMessage(),
    messageAtFinal,
    finalizationStatements,
    retargetedEntry: logicalStore
      ? (await loadSessionEntryAsync(sessionKey, { agentId: "main" })).entry
      : undefined,
  };
}

it("preserves agent-run commentary attachments after their source files are removed", () =>
  withImage(async (state, { imagePath, png }) => {
    const { imagePath: hookImagePath } = await writeMediaImage(state, "hook-added.png");
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
    const turn = await runMediaTurn(
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
    const { sessionKey, message } = turn;
    expectSuccess(turn);
    expect(message).toMatchObject({
      stopReason: "toolUse",
      openclawDelivery: { mediaUrls: [imagePath] },
      openclawDisplayContent: expect.arrayContaining([
        managedImage(),
        displayedText(`MEDIA:${hookImagePath}`),
      ]),
    });
    assert(Array.isArray(message?.openclawDisplayContent));
    const image = message.openclawDisplayContent
      .map(asOptionalRecord)
      .find((b) => b?.type === "image");
    assert(typeof image?.artifactId === "string", "Expected a managed commentary artifact");
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
    await storedImage(sessionKey, png);
  }));

it.each(["structured attachment", "store alias"] as const)(
  "owns the agent-run final %s before publishing completion",
  (source) =>
    withImage(async (state, { imagePath }) => {
      const text =
        source === "structured attachment" ? "Completed" : `Completed\nMEDIA:${imagePath}`;
      const authored = assistantText(text);
      const payload: ReplyPayload = { text };
      if (source === "structured attachment") {
        payload.mediaUrls = [imagePath];
        payload.attachments = [{ path: imagePath, mimeType: "image/png" }];
      }
      const turn = await runMediaTurn(state, authored, {
        payloads: [payload],
        retargetBeforeNormalization: source === "store alias",
      });
      const { sessionKey, message, messageAtFinal, finalizationStatements } = turn;
      expectSuccess(turn);
      expect(message?.content).toEqual(authored.content);
      if (source === "store alias") {
        expect(turn.retargetedEntry?.sandbox).toBe("required");
        expect(messageAtFinal?.openclawDisplayContent).toEqual(
          displayedImage({ artifactId: expect.any(String) }),
        );
        return;
      }
      expect(finalizationStatements).toBe(0);
      expectDisplay(messageAtFinal, displayedText("Completed"), managedImage());
      await storedImage(sessionKey);
    }),
);

it.each([true, false])(
  "enriches message-tool source media only without a committed owner (committed: %s)",
  (committed) =>
    withImage(async (state, { imagePath }) => {
      const text = "File ready";
      const idempotencyKey = "message-tool-source-reply";
      const { replyItems } = buildSourceReplyPayloadState({
        sessionKey: "agent:main:dispatch-owner",
        agentId: "main",
        payloads: [
          {
            text,
            mediaUrls: [imagePath],
            attachments: [{ path: imagePath, mimeType: "image/png" }],
            idempotencyKey,
            transcriptOwner: true,
          },
        ],
      });
      const turn = await runMediaTurn(state, assistantText(""), {
        payloads: replyItems,
        options: { sourceReplyDeliveryMode: "message_tool_only" },
        committedMirror: committed
          ? {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              idempotencyKey,
              content: [{ type: "text", text }],
              openclawDisplayContent: [{ type: "text", text }],
            }
          : undefined,
      });
      expectSuccess(turn);
      if (committed) {
        expect(turn.message?.openclawDisplayContent).toBeUndefined();
        expect(await listManagedImageRecordEntries({ sessionKey: turn.sessionKey })).toEqual([]);
      } else {
        expectDisplay(turn.messageAtFinal, displayedText(text), managedImage());
        await storedImage(turn.sessionKey);
      }
    }),
);

it.each<MediaFinal & { name: string; payload?: Partial<ReplyPayload> }>([
  { name: "sensitive media", payload: { sensitiveMedia: true } },
  { name: "reasoning media", payload: { isReasoning: true } },
  { name: "tool-only source reply", options: { sourceReplyDeliveryMode: "message_tool_only" } },
  { name: "private completion", options: { privateCompletion: true } },
  { name: "internal session effects", options: { sessionEffects: "internal" } },
  { name: "external delivery", options: { deliver: true, channel: "telegram" } },
  { name: "incognito dispatch", incognito: true },
])("does not retain final $name through the WebChat projector", (scenario) =>
  withImage(async (state, { imagePath }) => {
    const { sessionKey, message } = await runFinalTurn(state, imagePath, {
      payloads: [{ text: "Completed", mediaUrls: [imagePath], ...scenario.payload }],
      options: scenario.options,
      incognito: scenario.incognito,
    });
    expect(message?.openclawDisplayContent).toBeUndefined();
    expect(await listManagedImageRecordEntries({ sessionKey })).toEqual([]);
  }),
);

it.each(["abort", "permission", "placement", "route"] as const)(
  "settles prepared final media after a %s change",
  (change) =>
    withImage(async (state, { imagePath }) => {
      const { result, sessionKey, message, messageAtFinal } = await runFinalTurn(state, imagePath, {
        changeAfterPreparation: change,
      });
      expect(result.terminalOutcome.status).toBe(change === "route" ? "ok" : "error");
      if (change === "abort") {
        expect(result.terminalOutcome).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
      }
      if (change === "route") {
        expect(messageAtFinal?.openclawDisplayContent).toEqual(displayedImage());
        await storedImage(sessionKey);
      } else {
        expect(message?.openclawDisplayContent).toBeUndefined();
        expect(messageAtFinal?.openclawDisplayContent).toBeUndefined();
        expect(await listManagedImageRecordEntries({ sessionKey })).toEqual([]);
      }
    }),
);

it("settles committed media ownership even when the run aborts before publication", () =>
  withImage(async (state, { imagePath, png }) => {
    const { sessionKey, messageAtFinal } = await runFinalTurn(state, imagePath, {
      abortAfterCommit: true,
    });
    expect(messageAtFinal?.openclawDisplayContent).toEqual(displayedImage());
    await storedImage(sessionKey, png);
  }));
