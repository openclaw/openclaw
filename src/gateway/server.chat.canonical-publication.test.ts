import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { parseSseEvents } from "./http-stream.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const privateCaption =
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nPrivate synthetic instruction.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const publicCaption = "Public attachment caption. ".repeat(200).trimEnd();
const dryRunFinal = "The attachment was not sent because this was a dry run.";
const missingMediaFinal = "The attachment could not be sent because the file was not found.";
const cases = [
  { name: "ordinary", caption: "Attached proof.", expectedText: ["Attached proof."] },
  { name: "internal", caption: privateCaption, expectedText: [] },
  {
    name: "delivery",
    caption:
      "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
    expectedText: [],
  },
  {
    name: "mixed",
    caption: `Attached proof.\n${privateCaption}`,
    expectedText: ["Attached proof."],
  },
  {
    name: "quoted-marker",
    caption: "what is <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>?",
    expectedText: ["what is <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>?"],
  },
  {
    name: "details-cap",
    caption: `${publicCaption}\n${privateCaption}`,
    expectedText: [publicCaption],
  },
  {
    name: "dry-run",
    caption: privateCaption,
    finalText: dryRunFinal,
    expectedText: [dryRunFinal],
  },
  {
    name: "missing-media",
    caption: privateCaption,
    finalText: missingMediaFinal,
    expectedText: [missingMediaFinal],
  },
  {
    name: "cancel",
    caption: `Attached proof.\n${privateCaption}`,
    expectedText: ["Attached proof."],
  },
] as const;

it(
  "chat.send preserves canonical sanitized message publication through chat.history and artifacts.download",
  { timeout: 180_000 },
  async () => {
    const root = tempDirs.make("openclaw-canonical-display-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([state, workspace].map((directory) => fs.mkdir(directory)));
    const attachment = Buffer.from("canonical publication attachment\n");
    const media = path.join(workspace, "proof.txt");
    await fs.writeFile(media, attachment);
    const configPath = path.join(state, "openclaw.json");
    const environment = {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
    };
    const snapshot = captureEnv(Object.keys(environment));
    for (const [key, value] of Object.entries(environment)) {
      setTestEnvValue(key, value);
    }
    const toolResults: unknown[] = [];
    let selected: (typeof cases)[number] = cases[0];
    let primaryRequests = 0;
    let firstRequest = createDeferred();
    let releaseTool = createDeferred();
    let heldFinalRequest = createDeferred();
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream === "tool" && event.data.phase === "result") {
        toolResults.push(event.data);
      }
    });
    const provider = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isRecord(body)) {
          throw new Error("Invalid synthetic endpoint request");
        }
        if (body.model !== "canonical-proof") {
          writeOpenAiResponsesText(response, {
            text: "Attachment requested.",
            messageId: `summary_${selected.name}`,
            responseId: `summary_response_${selected.name}`,
          });
          return;
        }
        primaryRequests += 1;
        if (primaryRequests === 1) {
          if (selected.name === "details-cap") {
            firstRequest.resolve();
            await releaseTool.promise;
          }
          const item = {
            type: "function_call",
            id: "fc_reused",
            call_id: "call_reused",
            name: "message",
            status: "completed",
            arguments: JSON.stringify({
              action: "send",
              message: selected.caption,
              media:
                selected.name === "missing-media" ? path.join(workspace, "missing.txt") : media,
              filename: "proof.txt",
              contentType: "text/plain",
              ...(selected.name === "dry-run" ? { dryRun: true } : {}),
            }),
          };
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", arguments: "" },
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `response_${selected.name}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              },
            },
          ]);
        } else if (selected.name === "cancel") {
          heldFinalRequest.resolve();
        } else {
          writeOpenAiResponsesText(response, {
            text: "finalText" in selected ? selected.finalText : "NO_REPLY",
            messageId: `msg_${selected.name}`,
            responseId: `final_${selected.name}`,
          });
        }
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
      });
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing synthetic endpoint address");
      }
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              skills: [],
              model: { primary: "openai/canonical-proof", fallbacks: [] },
              models: { "openai/canonical-proof": { agentRuntime: { id: "openclaw" } } },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              openai: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "test",
                api: "openai-responses",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "canonical-proof",
                    name: "canonical-proof",
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 64000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          tools: { profile: "messaging" },
          plugins: {
            allow: ["openai"],
            slots: { memory: "none" },
            entries: { openai: { enabled: true } },
          },
          gateway: { controlUi: { enabled: false } },
          logging: { file: path.join(root, "gateway.log") },
        },
        configPath,
        token: "canonical-proof-token",
      });
      for (const scenario of cases) {
        selected = scenario;
        primaryRequests = 0;
        toolResults.length = 0;
        firstRequest = createDeferred();
        releaseTool = createDeferred();
        heldFinalRequest = createDeferred();
        const sessionKey = `agent:main:canonical-${scenario.name}`;
        const started = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Send the proof attachment in this conversation.",
          idempotencyKey: `canonical-${scenario.name}`,
        });
        let streamText = "";
        if (scenario.name === "details-cap") {
          await withTestTimeout(firstRequest.promise, 15_000, "tool request was not admitted");
          const stream = await fetch(
            `http://127.0.0.1:${gateway.port}/sessions/${encodeURIComponent(sessionKey)}/history`,
            {
              headers: {
                Authorization: "Bearer canonical-proof-token",
                "x-openclaw-scopes": "operator.read",
                Accept: "text/event-stream",
              },
              signal: AbortSignal.timeout(30_000),
            },
          );
          expect(stream.status).toBe(200);
          const reader = stream.body?.getReader();
          if (!reader) {
            throw new Error("Missing actual session-history stream");
          }
          const decoder = new TextDecoder();
          try {
            while (true) {
              const chunk = await reader.read();
              expect(chunk.done).toBe(false);
              streamText += decoder.decode(chunk.value, { stream: true });
              const frames = parseSseEvents(streamText);
              if (frames.some((frame) => frame.event === "history")) {
                releaseTool.resolve();
              }
              const messages = frames
                .filter((frame) => frame.event === "message")
                .map((frame): unknown => JSON.parse(frame.data))
                .filter(isRecord)
                .map((event) => event.message)
                .filter(isRecord);
              if (
                messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    Array.isArray(message.content) &&
                    message.content.some(
                      (block: unknown) => isRecord(block) && block.type === "attachment",
                    ),
                )
              ) {
                expect(messages).toContainEqual(
                  expect.objectContaining({
                    role: "assistant",
                    content: expect.arrayContaining([{ type: "text", text: publicCaption }]),
                  }),
                );
                expect(messages.some((message) => message.openclawMessageToolMirror)).toBe(false);
                break;
              }
            }
          } finally {
            releaseTool.resolve();
            await reader.cancel();
          }
        }
        if (scenario.name === "cancel") {
          await withTestTimeout(heldFinalRequest.promise, 15_000, "final request was not held");
          const aborted = await gateway.client.request("chat.abort", {
            sessionKey,
            runId: started.runId,
          });
          expect(aborted).toMatchObject({ aborted: true, runIds: [started.runId] });
        }
        const completed = await gateway.client.request<{ status: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        const history = await gateway.client.request<{
          sessionId: string;
          messages: Array<Record<string, unknown>>;
        }>("chat.history", { sessionKey, limit: 20 });
        const rawEvents = loadTranscriptEventsSync({
          agentId: "main",
          sessionId: history.sessionId,
          sessionKey,
        });
        const page = await gateway.client.request<{ messages: unknown[]; hasMore: boolean }>(
          "chat.history",
          { sessionKey, limit: 2 },
        );
        const listed = await gateway.client.request<ArtifactsListResult>("artifacts.list", {
          sessionKey,
          messageRole: "assistant",
        });
        const diagnosticCalls = rawEvents
          .filter(isRecord)
          .map((event) => event.message)
          .filter(isRecord)
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter(isRecord)
          .filter((block) => block.type === "toolCall");
        expect(diagnosticCalls, scenario.name).toContainEqual(
          expect.objectContaining({
            name: "message",
            arguments: expect.objectContaining({ message: scenario.caption }),
          }),
        );
        expect(toolResults, scenario.name).toHaveLength(1);
        if (scenario.name === "missing-media") {
          expect(toolResults[0]).toMatchObject({ isError: true });
        }
        if (scenario.name === "dry-run") {
          expect(toolResults[0]).toMatchObject({
            result: { details: { deliveryStatus: "dry_run", dryRun: true } },
          });
        }
        expect(
          history.messages.some((message) => message.openclawMessageToolMirror !== undefined),
          scenario.name,
        ).toBe(false);
        if (scenario.name === "details-cap") {
          const savedResult = rawEvents
            .filter(isRecord)
            .map((event) => event.message)
            .filter(isRecord)
            .find((message) => message.role === "toolResult");
          expect(savedResult?.details).toMatchObject({ persistedDetailsTruncated: true });
          expect(savedResult?.details).not.toHaveProperty("idempotencyKey");
          expect(savedResult?.details).not.toHaveProperty("sourceReplyTranscriptOwner");
        }
        expect(page).toMatchObject({ hasMore: true });
        expect(page.messages).toEqual(history.messages.slice(-2));
        const visibleText = history.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter(isRecord)
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        expect.soft(visibleText, scenario.name).toEqual(scenario.expectedText);
        expect
          .soft(completed.status, scenario.name)
          .toBe(scenario.name === "cancel" ? "error" : "ok");
        expect
          .soft(listed.artifacts, scenario.name)
          .toHaveLength(scenario.name === "dry-run" || scenario.name === "missing-media" ? 0 : 1);
        for (const artifact of listed.artifacts) {
          expect(artifact).toMatchObject({
            title: "proof.txt",
            mimeType: "text/plain",
            sizeBytes: attachment.length,
          });
          const download = await gateway.client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            { sessionKey, artifactId: artifact.id },
          );
          if (!download.url) {
            throw new Error("Missing authorized download URL");
          }
          const response = await fetch(new URL(download.url, `http://127.0.0.1:${gateway.port}`));
          const bytes = Buffer.from(await response.arrayBuffer());
          expect.soft(response.status, scenario.name).toBe(200);
          expect.soft(bytes, scenario.name).toEqual(attachment);
          expect(response.headers.get("content-type")).toBe("text/plain");
        }
        const requestsBeforeReplay = primaryRequests;
        const replay = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Send the proof attachment in this conversation.",
          idempotencyKey: `canonical-${scenario.name}`,
        });
        expect(replay.runId).toBe(started.runId);
        await gateway.client.request(
          "agent.wait",
          { runId: replay.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        expect(primaryRequests, scenario.name).toBe(requestsBeforeReplay);
        const reloaded = await gateway.client.request<typeof history>("chat.history", {
          sessionKey,
          limit: 20,
        });
        expect(reloaded.messages).toEqual(history.messages);
        expect(
          await gateway.client.request("artifacts.list", { sessionKey, messageRole: "assistant" }),
        ).toEqual(listed);
      }
    } finally {
      releaseTool.resolve();
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        unsubscribe();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => {
          provider.close(() => resolve());
        });
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
