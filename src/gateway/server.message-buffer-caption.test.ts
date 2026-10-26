import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createGatewayArtifactTestEnv } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const attachment = Buffer.from("current-source attachment");
const captionCases = [
  { name: "ordinary", caption: "Attached proof." },
  {
    name: "internal-context",
    caption:
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  },
  {
    name: "delivery-metadata",
    caption:
      "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  },
] as const;

it(
  "chat.send publishes sanitized message buffers through history and authorized artifacts.download",
  { timeout: 180_000 },
  async () => {
    const root = tempDirs.make("openclaw-message-buffer-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([state, workspace].map((directory) => fs.mkdir(directory)));
    const explicitBytes = Buffer.from("explicit source wins");
    const explicitMedia = path.join(workspace, "explicit.txt");
    const deniedMedia = path.join(root, "private.txt");
    await fs.writeFile(explicitMedia, explicitBytes);
    await fs.writeFile(deniedMedia, "private file");
    type Scenario = {
      name: string;
      caption: string;
      buffer?: string;
      media?: string;
      expected: "attachment" | "suppressed" | "error" | "text";
      error?: RegExp;
      bytes?: Buffer;
      finalText?: string;
    };
    const attached = (scenario: (typeof captionCases)[number]): Scenario => ({
      ...scenario,
      buffer: attachment.toString("base64"),
      expected: "attachment",
      bytes: attachment,
    });
    const cases: [Scenario, ...Scenario[]] = [
      attached(captionCases[0]),
      ...captionCases.slice(1).map(attached),
      ...[undefined, "", "  "].map((buffer, index) => ({
        name: `empty-${index}`,
        caption: captionCases[1].caption,
        buffer,
        expected: "suppressed" as const,
        finalText: "No attachment was provided, so nothing was sent.",
      })),
      { name: "text-only", caption: "Attached proof.", expected: "text" },
      {
        name: "invalid",
        caption: captionCases[1].caption,
        buffer: "%%%",
        expected: "error",
        error: /invalid base64 data/,
        finalText: "The attachment data is invalid, so it was not sent.",
      },
      {
        name: "oversized",
        caption: captionCases[2].caption,
        buffer: Buffer.alloc(2048).toString("base64"),
        expected: "error",
        error: /Media too large/,
        finalText: "The attachment exceeds the size limit, so it was not sent.",
      },
      {
        name: "explicit",
        caption: captionCases[1].caption,
        buffer: "%%%",
        media: explicitMedia,
        expected: "attachment",
        bytes: explicitBytes,
      },
      {
        name: "denied",
        caption: captionCases[1].caption,
        media: deniedMedia,
        expected: "error",
        error: /allowed directory|could not be staged/,
        finalText: "The attachment could not be accessed, so it was not sent.",
      },
    ];
    const configPath = path.join(state, "openclaw.json");
    const environment = createGatewayArtifactTestEnv(root, state, configPath);
    const snapshot = captureEnv(Object.keys(environment));
    for (const [key, value] of Object.entries(environment)) {
      setTestEnvValue(key, value);
    }
    let selected = cases[0];
    let requests: Array<Record<string, unknown>> = [];
    const provider = createServer((request, response) => {
      void (async () => {
        const text = await readRequestText(request);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = JSON.parse(text);
        if (!isRecord(body)) {
          throw new Error("Invalid completion request");
        }
        requests.push(body);
        if (body.model !== "buffer-proof") {
          writeOpenAiResponsesText(response, {
            text: "Attachment requested.",
            messageId: `summary_${selected.name}`,
            responseId: `summary_response_${selected.name}`,
          });
          return;
        }
        if (requests.filter((candidate) => candidate.model === "buffer-proof").length === 1) {
          writeToolCall(
            response,
            "message",
            {
              action: "send",
              message: selected.caption,
              buffer: selected.buffer,
              media: selected.media,
              filename: "proof.txt",
              contentType: "text/plain",
            },
            10,
            10,
          );
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
        "buffer-proof",
      );
      Object.assign(model.config.models[0], { contextWindow: 16000, maxTokens: 256 });
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              mediaMaxMb: 1 / 1024,
              skipBootstrap: true,
              skills: [],
              model: { primary: "openai/buffer-proof", fallbacks: [] },
              models: { "openai/buffer-proof": { agentRuntime: { id: "openclaw" } } },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: { openai: { ...model.config, request: { allowPrivateNetwork: true } } },
          },
          // This provider scripts direct message calls to prove buffer handling, not discovery.
          tools: { profile: "messaging", toolSearch: false },
          plugins: {
            allow: ["openai"],
            slots: { memory: "none" },
            entries: { openai: { enabled: true } },
          },
          logging: { file: path.join(root, "gateway.log") },
        },
        configPath,
        token: "buffer-proof-token",
      });
      const waitForRun = (runId: string) =>
        gateway!.client.request<{ status: string }>(
          "agent.wait",
          { runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
      for (const scenario of cases) {
        selected = scenario;
        requests = [];
        const sessionKey = `agent:main:buffer-${scenario.name}`;
        const send = () =>
          gateway!.client.request<{ runId: string }>("chat.send", {
            sessionKey,
            message: "Send the attachment in this conversation.",
            idempotencyKey: `buffer-${scenario.name}`,
          });
        const started = await send();
        const completed = await waitForRun(started.runId);
        const history = await gateway.client.request<{ messages: Array<Record<string, unknown>> }>(
          "chat.history",
          { sessionKey, limit: 20 },
        );
        const listed = await gateway.client.request<ArtifactsListResult>("artifacts.list", {
          sessionKey,
          messageRole: "assistant",
        });
        const visibleText = history.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter(isRecord)
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        const expectedText =
          scenario.name === "ordinary" || scenario.expected === "text" ? [scenario.caption] : [];
        if (scenario.finalText) {
          expectedText.push(scenario.finalText);
        }
        expect.soft(visibleText, scenario.name).toEqual(expectedText);
        const toolResults = history.messages.filter((message) => message.role === "toolResult");
        expect.soft(toolResults, scenario.name).toHaveLength(1);
        if (scenario.error) {
          expect.soft(toolResults[0], scenario.name).toMatchObject({ isError: true });
          expect.soft(JSON.stringify(toolResults), scenario.name).toMatch(scenario.error);
        }
        if (scenario.expected === "suppressed") {
          expect
            .soft(JSON.stringify(toolResults), scenario.name)
            .toContain("internal_runtime_context_echo");
        }
        expect.soft(completed.status, scenario.name).toBe("ok");
        expect
          .soft(listed.artifacts, scenario.name)
          .toHaveLength(scenario.expected === "attachment" ? 1 : 0);
        for (const artifact of listed.artifacts) {
          const downloaded = await gateway.client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            { sessionKey, artifactId: artifact.id },
          );
          expect.soft(downloaded.artifact, scenario.name).toMatchObject({
            mimeType: "text/plain",
            title: "proof.txt",
          });
          if (!downloaded.url) {
            throw new Error("Managed artifact URL missing");
          }
          const response = await fetch(new URL(downloaded.url, `http://127.0.0.1:${gateway.port}`));
          expect(response.ok).toBe(true);
          expect
            .soft(Buffer.from(await response.arrayBuffer()), scenario.name)
            .toEqual(scenario.bytes);
        }
        const primaryCount = requests.filter((request) => request.model === "buffer-proof").length;
        const replay = await send();
        expect(replay.runId).toBe(started.runId);
        await waitForRun(replay.runId);
        expect(
          await gateway.client.request("artifacts.list", { sessionKey, messageRole: "assistant" }),
        ).toEqual(listed);
        expect(requests.filter((request) => request.model === "buffer-proof")).toHaveLength(
          primaryCount,
        );
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        await closeProvider(provider);
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
