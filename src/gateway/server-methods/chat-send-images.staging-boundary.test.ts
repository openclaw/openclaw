import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveProviderContext } from "../../../packages/ai/src/provider-types.js";
import { buildOpenAIResponsesParams } from "../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  buildPromptImageFailureNotice,
  detectAndLoadPromptImages,
  hydratePromptMediaMessages,
  materializeProviderContext,
} from "../../agents/embedded-agent-runner/run/images.js";
import { wrapStreamFnWithMessageTransform } from "../../agents/embedded-agent-runner/run/message-transform-stream-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createHostSandboxFsBridge } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import { stageSandboxMedia } from "../../auto-reply/reply/stage-sandbox-media.js";
import type { RuntimeMsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

registerAgentSessionLoopTestLifecycle();

it("retains a managed image across sandbox staging and a fresh attempt", async () => {
  await withOpenClawTestState({ label: "native-image-staging" }, async (state) => {
    const bytes = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const source = state.statePath("media", "inbound", "photo.png");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, bytes);
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          skipBootstrap: true,
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceRoot: state.path("sandboxes"),
            workspaceAccess: "none",
          },
        },
      },
    };
    await state.writeConfig(cfg);
    const media = [{ path: source, url: "media://inbound/photo.png", contentType: "image/png" }];
    // chat.send accepts durable originals before the turn stages its private copy.
    const message = buildPersistedUserTurnMessage({
      text: "Inspect this attachment",
      idempotencyKey: "sandbox-staging",
      timestamp: 1,
      media,
    });
    const ctx: RuntimeMsgContext = { media };
    await stageSandboxMedia({
      ctx,
      sessionCtx: ctx as TemplateContext,
      cfg,
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: state.workspaceDir,
    });
    const fact = ctx.media?.[0];
    assert(fact?.workspaceDir && fact.path && fact.staged, "attachment was not staged");
    expect(await fs.readFile(path.resolve(fact.workspaceDir, fact.path))).toEqual(bytes);
    const options = {
      workspaceDir: fact.workspaceDir,
      model: { input: ["text", "image"] },
      sandbox: { root: fact.workspaceDir, bridge: createHostSandboxFsBridge(fact.workspaceDir) },
      workspaceOnly: true,
      imageSessionKey: state.root,
    };
    const prepared = await detectAndLoadPromptImages({
      ...options,
      prompt: "Inspect this attachment",
      media: ctx.media,
      userTurnTranscriptRecorder: { resolveMessage: async () => message },
    });
    expect(prepared.failedMediaCount).toBe(0);
    expect(prepared.images).toHaveLength(1);
    const manager = SessionManager.inMemory(fact.workspaceDir);
    await manager.appendMessageAsync(message);
    const requests: string[] = [];
    for (const turn of [0, 1, 2]) {
      if (turn === 2) {
        await fs.rm(source);
      }
      const { session } = await createTestSession({
        sessionManager: manager,
        model: { ...testModel, input: ["text", "image"] },
      });
      session.agent.transformContext = (messages) => hydratePromptMediaMessages(messages, options);
      session.agent.streamFn = wrapStreamFnWithMessageTransform(
        async (model, context, streamOptions) => {
          const provider = await resolveProviderContext(context, streamOptions);
          const messages = provider.messages.map((entry) => {
            if (entry.role !== "user") {
              return entry;
            }
            return {
              ...entry,
              content:
                typeof entry.content === "string"
                  ? entry.content
                  : entry.content.map((part) => {
                      assert(part.type !== "video", "unexpected video in image-only fixture");
                      return part;
                    }),
            };
          });
          requests.push(
            JSON.stringify(buildOpenAIResponsesParams(model, { ...provider, messages }, undefined)),
          );
          return createAssistantResultStream(createAssistant(model, "Done"));
        },
        (messages) => messages,
        (input) => materializeProviderContext({ ...options, ...input }),
      );
      await session.prompt(
        turn === 0 ? "Inspect this attachment" : "What color was it?",
        turn === 0
          ? { images: prepared.images, persistedUserIdempotencyKey: message.idempotencyKey }
          : {},
      );
      session.dispose();
    }
    expect(requests.map((request) => request.match(/"type":"input_image"/g)?.length ?? 0)).toEqual([
      1, 1, 0,
    ]);
    expect(requests[2]).toContain(buildPromptImageFailureNotice(1));
  });
});
