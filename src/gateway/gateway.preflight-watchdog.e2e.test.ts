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

type ChatFixtureConfigure = NonNullable<Parameters<typeof createChatFixture>[1]>["configure"] & {};
import { buildOpenAiResponsesTestModel } from "./test-openai-responses-model.js";

const sessionKey = "agent:main:main";
const summaryModel = "preflight-summary";

function writeEvent(response: ServerResponse, event: object) {
  response.write("data: " + JSON.stringify(event) + "\n\n");
}

function openMessageStream(response: ServerResponse, id: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
  });
}

function writeDelta(response: ServerResponse, id: string, delta: string) {
  writeEvent(response, {
    type: "response.output_text.delta",
    item_id: id,
    output_index: 0,
    content_index: 0,
    delta,
  });
}

const configurePreflight =
  (compaction: Record<string, unknown>): ChatFixtureConfigure =>
  (config, model) => ({
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
          ...compaction,
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
  });

it(
  "delivers a Control UI turn after a private memory flush streams past six minutes",
  { timeout: 180_000 },
  async () => {
    // NO_REPLY also appears in the foreground runtime instructions.
    const flushDeltas = ["Private", " watchdog", " canary", " 48c7ef."];
    const flushText = flushDeltas.join("");
    const requests: string[] = [];
    let flush: ServerResponse | undefined;
    const fixture = createChatFixture("preflight-watchdog", {
      configure: configurePreflight({ memoryFlush: { enabled: true } }),
      respond: async (body, _sessionId, response) => {
        if (body.includes("Pre-compaction memory flush")) {
          requests.push("flush");
          openMessageStream(response, "msg_flush");
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
      const scope = await seedLongSession(120_000);
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
      for (const delta of flushDeltas) {
        offset += 100_000;
        expect((await operation.watchdog.tick()).action).toBe("observe");
        writeDelta(response, "msg_flush", delta);
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
        content: [{ type: "output_text", text: flushText, annotations: [] }],
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
        fixture.client.request("agent.wait", { runId, timeoutMs: 45_000 }, { timeoutMs: 50_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(requests).toEqual(["flush", "summary", "reply"]);
      const transcript = JSON.stringify(loadTranscriptEventsSync(scope));
      expect(transcript).toContain("The foreground reply arrived.");
      expect(transcript.includes(flushText)).toBe(false);
      expect(fixture.requests.slice(1).some((body) => body.includes(flushText))).toBe(false);
    } finally {
      flush?.destroy();
      vi.mocked(Date.now).mockRestore?.();
      await fixture.close();
    }
  },
);

type StallCase = { stage: "memory flush" | "compaction" };

it.each([{ stage: "memory flush" }, { stage: "compaction" }] satisfies StallCase[])(
  "continues a Control UI turn promptly when its $stage stalls without output",
  { timeout: 180_000 },
  async ({ stage }) => {
    const silenceSeconds = 5;
    const requests: string[] = [];
    const held: ServerResponse[] = [];
    const chatEvents: Array<Record<string, unknown>> = [];
    let lastOutputAt = 0;
    const fixture = createChatFixture("preflight-stall", {
      onEvent: ({ event, payload }) => {
        if (event === "chat" && payload && typeof payload === "object") {
          chatEvents.push(payload as Record<string, unknown>);
        }
      },
      configure: configurePreflight({
        timeoutSeconds: silenceSeconds,
        memoryFlush: { enabled: stage === "memory flush" },
      }),
      respond: async (body, _sessionId, response) => {
        const { model } = JSON.parse(body) as { model: string };
        const kind = body.includes("Pre-compaction memory flush")
          ? "flush"
          : model === summaryModel
            ? "summary"
            : "reply";
        requests.push(kind);
        if (
          (stage === "memory flush" && kind === "flush") ||
          (stage === "compaction" && kind === "summary")
        ) {
          // Accept the request, emit one delta, then go silent while keeping the socket open.
          openMessageStream(response, "msg_stall");
          writeDelta(response, "msg_stall", "Partial");
          lastOutputAt = performance.now();
          held.push(response);
          return undefined;
        }
        return kind === "summary"
          ? "Earlier messages discussed the fixture."
          : "The foreground reply arrived.";
      },
    });
    try {
      await fixture.start();
      await seedLongSession(140_000);
      const { runId } = await fixture.client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "Answer after maintenance.",
        idempotencyKey: randomUUID(),
      });
      const wait = await fixture.client.request<{ status: string }>(
        "agent.wait",
        { runId, timeoutMs: 60_000 },
        { timeoutMs: 65_000 },
      );
      const failedAfterMs = performance.now() - lastOutputAt;
      const delivered = JSON.stringify(chatEvents.filter((event) => event.runId === runId));
      // Bounded by the configured silence window, far below the 360s reply watchdog.
      expect(failedAfterMs).toBeGreaterThanOrEqual(silenceSeconds * 1000 - 250);
      expect(failedAfterMs).toBeLessThan(silenceSeconds * 1000 + 15_000);
      expect(delivered).not.toContain("stopped making progress");
      // A silent flush is abandoned as an ordinary flush failure; compaction then proceeds.
      // A silent compaction reports its own timeout before the reply watchdog's backstop, and a
      // prompt that still fits continues to the reply instead of a generic stall.
      expect(requests).toEqual(
        stage === "memory flush" ? ["flush", "summary", "reply"] : ["summary", "reply"],
      );
      expect(wait.status).toBe("ok");
      expect(delivered).toContain("The foreground reply arrived.");
    } finally {
      for (const response of held) {
        response.destroy();
      }
      await fixture.close();
    }
  },
);

async function seedLongSession(totalTokens: number) {
  const now = Date.now();
  const scope = {
    agentId: "main",
    sessionId: randomUUID(),
    sessionKey,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: now,
    totalTokens,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  });
  for (let turn = 0; turn < 4; turn += 1) {
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Historical request " + turn, timestamp: now },
    });
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer " + turn }],
        api: "openai-responses",
        provider: "mock-openai",
        model: "preflight-watchdog-fixture",
        usage: {
          input: totalTokens,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: totalTokens + 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      },
    });
  }
  return scope;
}
