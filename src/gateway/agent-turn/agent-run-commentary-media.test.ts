import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { makeRunAgentAttemptParams } from "../../agents/command/attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "../../agents/command/attempt-execution.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  publishTranscriptUpdate,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as hookRunnerGlobal from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveManagedImageOriginalPath } from "../managed-image-attachments.custody.js";
import { resolveManagedOutgoingMediaArtifactDownload } from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { loadSessionEntry } from "../session-utils.js";
import { dispatchAgentRunWithCommentaryMedia } from "./agent-run-commentary-media.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));
// mock-isolation: Skip command admission while retaining real attempt forwarding below.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));
// mock-isolation: Replace model execution while preserving real dispatch and transcript custody.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.embedded }));

afterEach(() => vi.restoreAllMocks());

it("preserves agent-run commentary attachments after their source files are removed", async () => {
  await withOpenClawTestState({ label: "agent-commentary-media" }, async (state) => {
    const run = createTrackedDispatch();
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const scope = {
      agentId: "main",
      sessionId: run.entry.sessionId,
      sessionKey: run.sessionKey,
      storePath: loadSessionEntry(run.sessionKey, { agentId: "main" }).storePath,
    };
    const sessionEntry = {
      sessionId: scope.sessionId,
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    await replaceSessionEntry(scope, sessionEntry);
    // Admit the shared media store before entering the run-owned transcript context.
    expect(await listManagedImageRecordEntries({ sessionKey: run.sessionKey })).toEqual([]);
    const imagePath = path.join(state.workspaceDir, "before.png");
    const hookImagePath = path.join(state.workspaceDir, "hook-added.png");
    const png = createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await Promise.all([imagePath, hookImagePath].map((file) => fs.writeFile(file, png)));
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
      createHookRunner(
        createMockPluginRegistry([
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
        ]),
      ),
    );
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: run.runId,
      sessionId: scope.sessionId,
    });
    mocks.command.mockImplementationOnce(async (options) => {
      const result = await runAgentAttempt(
        makeRunAgentAttemptParams({
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          cfg,
          sessionEntry,
          sessionKey: run.sessionKey,
          sessionTarget: scope,
          storePath: scope.storePath,
          runId: run.runId,
          agentHarnessRuntimeOverride: "openclaw",
          pluginsEnabled: false,
          opts: options,
        }),
      );
      return { payloads: [], meta: result.meta };
    });
    mocks.embedded.mockImplementationOnce(async (options) => {
      try {
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: scope,
            assertCommitAllowed: () => run.entry.controller.signal.throwIfAborted(),
            withTranscriptWrite: (operation) => lifecycle.withTranscriptWrite(operation),
          },
          async () => {
            const message = runAgentHarnessBeforeMessageWriteHook({
              message: attachSessionTranscriptRunId(
                buildAssistantMessage({
                  model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
                  content: [
                    {
                      type: "text",
                      text: `Before\nMEDIA:${imagePath}`,
                      textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
                    },
                    { type: "toolCall", id: "next", name: "read", arguments: { path: "next.ts" } },
                  ],
                  stopReason: "toolUse",
                  usage: buildUsageWithNoCost({}),
                }),
                run.runId,
              ),
              prepareAssistantTranscriptMessage: options.prepareAssistantTranscriptMessage,
            });
            if (!message) {
              throw new Error("Expected a commentary message");
            }
            expect(
              appendTranscriptMessageSync(scope, { eventId: "progress", message }),
            ).toMatchObject({
              ok: true,
            });
            await publishTranscriptUpdate(scope, {
              message,
              messageId: "progress",
              runId: run.runId,
            });
          },
        );
      } finally {
        await lifecycle.dispose();
      }
      return { payloads: [], meta: { durationMs: 0 } };
    });
    const result = await dispatchAgentRunWithCommentaryMedia(
      {
        admittedRunEntry: run.entry,
        ingressOpts: {
          message: "Show progress",
          sessionKey: run.sessionKey,
          sessionId: scope.sessionId,
          abortSignal: run.entry.controller.signal,
          allowModelOverride: false,
        },
        runId: run.runId,
        dedupeKeys: [],
        abortController: run.entry.controller,
        cleanupAbortController: () => {
          run.context.chatAbortControllers.delete(run.runId);
        },
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context: run.context,
      },
      { cfg, client: null, activeSessionAgentId: "main" },
    );
    expect(result.terminalOutcome.status).toBe("ok");
    expect(run.context.logGateway.warn).not.toHaveBeenCalled();
    const event = loadTranscriptEventsSync(scope)
      .map(asOptionalRecord)
      .find((entry) => entry?.type === "message" && entry.id === "progress");
    const message = asOptionalRecord(event?.message);
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
        sessionKey: run.sessionKey,
        agentId: "main",
        artifactId: image.artifactId,
      }),
    ).resolves.toMatchObject({
      artifactId: image.artifactId,
      mimeType: "image/png",
      sizeBytes: png.length,
    });
    const records = await listManagedImageRecordEntries({ sessionKey: run.sessionKey });
    expect(records).toHaveLength(1);
    expect(await fs.readFile(resolveManagedImageOriginalPath(records[0]!.record))).toEqual(png);
  });
});
