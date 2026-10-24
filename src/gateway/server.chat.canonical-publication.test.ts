import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCallResponse,
} from "./gateway-provider-fixture.test-support.js";
import { parseSseEvents } from "./http-stream.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const privateCaption =
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nPrivate synthetic instruction.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const publicCaption = "Public attachment caption. ".repeat(200).trimEnd();
const dryRunFinal = "The attachment was not sent because this was a dry run.";
const missingMediaFinal = "The attachment could not be sent because the file was not found.";
function publicationCase<Name extends string>(
  name: Name,
  caption: string,
  expectedText: string[],
  finalText?: string,
) {
  return { name, caption, expectedText, finalText };
}
const cases = [
  publicationCase("ordinary", "Attached proof.", ["Attached proof."]),
  publicationCase("internal", privateCaption, []),
  publicationCase(
    "delivery",
    "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
    [],
  ),
  publicationCase("mixed", `Attached proof.\n${privateCaption}`, ["Attached proof."]),
  publicationCase("quoted-marker", "what is <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>?", [
    "what is <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>?",
  ]),
  publicationCase("details-cap", `${publicCaption}\n${privateCaption}`, [publicCaption]),
  publicationCase("dry-run", privateCaption, [dryRunFinal], dryRunFinal),
  publicationCase("missing-media", privateCaption, [missingMediaFinal], missingMediaFinal),
  publicationCase("cancel", `Attached proof.\n${privateCaption}`, ["Attached proof."]),
] as const;
const messagesFrom = (events: unknown[]) =>
  events
    .filter(isRecord)
    .map((event) => event.message)
    .filter(isRecord);
const contentFrom = (messages: Record<string, unknown>[]) =>
  messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(isRecord);
type History = { sessionId: string; messages: Record<string, unknown>[]; hasMore: boolean };

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
        const input = await readProviderBody(request);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = JSON.parse(input);
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
              // Keep a follow-up request open so cancellation happens after delivery.
              ...(selected.name === "cancel" ? { final: false } : {}),
            }),
          };
          writeToolCallResponse(response, item, `response_${selected.name}`, 10, 10);
        } else if (selected.name === "cancel") {
          heldFinalRequest.resolve();
        } else {
          writeOpenAiResponsesText(response, {
            text: selected.finalText ?? "NO_REPLY",
            messageId: `msg_${selected.name}`,
            responseId: `final_${selected.name}`,
          });
        }
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const model = buildMockOpenAiResponsesProvider(
        await listenProvider(provider),
        "canonical-proof",
      );
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
                ...model.config,
                request: { allowPrivateNetwork: true },
                models: [{ ...model.config.models[0], contextWindow: 64000, maxTokens: 8192 }],
              },
            },
          },
          // This provider scripts direct message calls to prove publication, not discovery.
          tools: { profile: "messaging", toolSearch: false },
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
      const rpc = gateway.client.request.bind(gateway.client);
      const wait = (runId: string) =>
        rpc<{ status: string }>("agent.wait", { runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
      for (const scenario of cases) {
        selected = scenario;
        primaryRequests = 0;
        toolResults.length = 0;
        firstRequest = createDeferred();
        releaseTool = createDeferred();
        heldFinalRequest = createDeferred();
        const sessionKey = `agent:main:canonical-${scenario.name}`;
        const send = () =>
          rpc<{ runId: string }>("chat.send", {
            sessionKey,
            message: "Send the proof attachment in this conversation.",
            idempotencyKey: `canonical-${scenario.name}`,
          });
        const readHistory = (limit = 20) => rpc<History>("chat.history", { sessionKey, limit });
        const listArtifacts = () =>
          rpc<ArtifactsListResult>("artifacts.list", {
            sessionKey,
            messageRole: "assistant",
          });
        const started = await send();
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
              const messages = messagesFrom(
                frames
                  .filter((frame) => frame.event === "message")
                  .map((frame): unknown => JSON.parse(frame.data)),
              );
              if (
                contentFrom(messages.filter((message) => message.role === "assistant")).some(
                  (block) => block.type === "attachment",
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
          const aborted = await rpc("chat.abort", {
            sessionKey,
            runId: started.runId,
          });
          expect(aborted).toMatchObject({ aborted: true, runIds: [started.runId] });
        }
        const completed = await wait(started.runId);
        const history = await readHistory();
        const rawEvents = loadTranscriptEventsSync({
          agentId: "main",
          sessionId: history.sessionId,
          sessionKey,
        });
        const page = await readHistory(2);
        const listed = await listArtifacts();
        const rawMessages = messagesFrom(rawEvents);
        const diagnosticCalls = contentFrom(rawMessages).filter(
          (block) => block.type === "toolCall",
        );
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
          const savedResult = rawMessages.find((message) => message.role === "toolResult");
          expect(savedResult?.details).toMatchObject({ persistedDetailsTruncated: true });
          expect(savedResult?.details).not.toHaveProperty("idempotencyKey");
          expect(savedResult?.details).not.toHaveProperty("sourceReplyTranscriptOwner");
        }
        expect({ hasMore: page.hasMore, messages: page.messages }).toEqual({
          hasMore: true,
          messages: history.messages.slice(-2),
        });
        const visibleText = contentFrom(
          history.messages.filter((message) => message.role === "assistant"),
        )
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        expect
          .soft(
            { text: visibleText, status: completed.status, artifacts: listed.artifacts.length },
            scenario.name,
          )
          .toEqual({
            text: scenario.expectedText,
            status: scenario.name === "cancel" ? "error" : "ok",
            artifacts: scenario.name === "dry-run" || scenario.name === "missing-media" ? 0 : 1,
          });
        for (const artifact of listed.artifacts) {
          expect(artifact).toMatchObject({
            title: "proof.txt",
            mimeType: "text/plain",
            sizeBytes: attachment.length,
          });
          const download = await rpc<ArtifactsDownloadResult>("artifacts.download", {
            sessionKey,
            artifactId: artifact.id,
          });
          if (!download.url) {
            throw new Error("Missing authorized download URL");
          }
          const response = await fetch(new URL(download.url, `http://127.0.0.1:${gateway.port}`));
          const bytes = Buffer.from(await response.arrayBuffer());
          expect.soft([response.status, bytes], scenario.name).toEqual([200, attachment]);
          expect(response.headers.get("content-type")).toBe("text/plain");
        }
        const requestsBeforeReplay = primaryRequests;
        const replay = await send();
        expect(replay.runId).toBe(started.runId);
        await wait(replay.runId);
        expect(primaryRequests, scenario.name).toBe(requestsBeforeReplay);
        const reloaded = await readHistory();
        expect(reloaded.messages).toEqual(history.messages);
        expect(await listArtifacts()).toEqual(listed);
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
        await closeProvider(provider);
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
