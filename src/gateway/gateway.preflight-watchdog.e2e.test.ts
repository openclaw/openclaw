import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { buildOpenAiResponsesTestModel } from "./test-openai-responses-model.js";

function writeEvent(response: ServerResponse, event: object) {
  response.write("data: " + JSON.stringify(event) + "\n\n");
}

it(
  "delivers a Control UI turn after a private memory flush streams past six minutes",
  { timeout: 150_000 },
  async () => {
    const sessionKey = "agent:main:main";
    const summaryModel = "preflight-summary";
    const requests: string[] = [];
    let flush: ServerResponse | undefined;
    const fixture = createChatFixture("preflight-watchdog", {
      configure: (config, model) => ({
        ...config,
        agents: {
          defaults: {
            ...config.agents?.defaults,
            timeoutSeconds: 900,
            compaction: {
              model: model.providerId + "/" + summaryModel,
              keepRecentTokens: 1,
              recentTurnsPreserve: 1,
              qualityGuard: { enabled: false },
              memoryFlush: { enabled: true },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [model.providerId]: {
              ...model.config,
              models: [...model.config.models, buildOpenAiResponsesTestModel(summaryModel)],
            },
          },
        },
        plugins: {
          allow: ["memory-core"],
          // The chat fixture intentionally starts with an empty bundled plugin directory.
          load: { paths: [path.resolve("extensions/memory-core")] },
          slots: { memory: "memory-core" },
          entries: { "memory-core": { enabled: true, config: { dreaming: { enabled: false } } } },
        },
      }),
      respond: async (body, _sessionId, response) => {
        if (body.includes("Pre-compaction memory flush")) {
          requests.push("flush");
          response.writeHead(200, { "content-type": "text/event-stream" });
          writeEvent(response, {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "msg_flush",
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          });
          flush = response;
          return undefined;
        }
        const { model } = JSON.parse(body) as { model: string };
        const isSummary = model === summaryModel;
        requests.push(isSummary ? "summary" : "reply");
        return isSummary
          ? "Earlier messages discussed the fixture."
          : "The foreground reply arrived.";
      },
    });
    const wallNow = Date.now;
    let offset = 0;
    try {
      await fixture.start();
      const sessionId = randomUUID();
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: wallNow(),
        totalTokens: 120_000,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      });
      for (let turn = 0; turn < 4; turn += 1) {
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Historical request " + turn, timestamp: wallNow() },
        });
        await appendTranscriptMessage(scope, {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Historical answer " + turn }],
            api: "openai-responses",
            provider: "mock-openai",
            model: "preflight-watchdog-fixture",
            usage: {
              input: 120_000,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 120_010,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: wallNow(),
          },
        });
      }
      vi.spyOn(Date, "now").mockImplementation(() => wallNow() + offset);
      const { runId } = await fixture.client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "Answer after maintenance.",
        idempotencyKey: randomUUID(),
      });
      await vi.waitFor(() => expect(requests).toEqual(["flush"]), { timeout: 15_000 });
      const response = flush!;
      const operation = findSessionControllerOperationByRunId(runId)!;
      expect(operation.phase).toBe("memory_flushing");
      // Accelerate the reply watchdog's wall clock, leaving actual socket IO and timers intact.
      for (const delta of ["NO", "_", "RE", "PLY"]) {
        offset += 100_000;
        expect((await operation.watchdog.tick()).action).toBe("observe");
        writeEvent(response, {
          type: "response.output_text.delta",
          item_id: "msg_flush",
          output_index: 0,
          content_index: 0,
          delta,
        });
        await vi.waitFor(() => {
          const { lastProgressReason, semanticProgressAtMs } = operation.watchdog.snapshot();
          expect(lastProgressReason).toBe("memory_flush:model_output");
          expect(semanticProgressAtMs).toBeGreaterThanOrEqual(wallNow() + offset - 1_000);
        });
      }
      const item = {
        id: "msg_flush",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "NO_REPLY", annotations: [] }],
      };
      writeEvent(response, { type: "response.output_item.done", output_index: 0, item });
      writeEvent(response, {
        type: "response.completed",
        response: {
          id: "resp_flush",
          status: "completed",
          output: [item],
          usage: { input_tokens: 117_000, output_tokens: 4, total_tokens: 117_004 },
        },
      });
      response.end("data: [DONE]\n\n");
      await expect(
        fixture.client.request("agent.wait", { runId, timeoutMs: 15_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(requests).toEqual(["flush", "summary", "reply"]);
      const transcript = JSON.stringify(loadTranscriptEventsSync(scope));
      expect(transcript).toContain("The foreground reply arrived.");
      expect(transcript).not.toContain("NO_REPLY");
    } finally {
      flush?.destroy();
      vi.mocked(Date.now).mockRestore?.();
      await fixture.close();
    }
  },
);
