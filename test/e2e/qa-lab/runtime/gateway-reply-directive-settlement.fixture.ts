import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { loadSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { createPlaybackMediaFixture } from "../../../fixtures/media-playback.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

export const SPOKEN_TEXT = "The report has finished successfully.";
export const AUTHORED_REPLY_ID = "older-message-42";
export const TERMINAL_TEXT = "The final text report is ready for the earlier message.";
const CHANNEL = "settlement-proof";
const SDK_SUBPATHS = ["channel-inbound", "channel-ingress-runtime", "channel-outbound"];

type TransportPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  audioAsVoice?: boolean;
  spokenText?: string;
};
export type ProofTrace = {
  sdkPaths: Record<string, string>;
  sessionKey?: string;
  events: Array<{
    stage: "entered" | "accepted";
    sequence: number;
    kind: string;
    payload: TransportPayload;
    media: Array<{ path: string; bytes: number; sha256: string }>;
  }>;
  synthesis: Array<{ text: string; target: string }>;
  settled: boolean;
  disposed: boolean;
  runJoined: boolean;
  runRejected: boolean;
};

const CAPTURE_PLUGIN = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const inbound = require("openclaw/plugin-sdk/channel-inbound");
const ingress = require("openclaw/plugin-sdk/channel-ingress-runtime");
const outbound = require("openclaw/plugin-sdk/channel-outbound");
module.exports = {
  id: "settlement-proof",
  register(api) {
    const cfg = api.config;
    const settings = api.pluginConfig;
    const id = "settlement-proof";
    const trace = { sdkPaths: {}, events: [], synthesis: [], settled: false, disposed: false, runJoined: false, runRejected: false };
    for (const name of ["channel-inbound", "channel-ingress-runtime", "channel-outbound"]) {
      trace.sdkPaths[name] = fs.realpathSync(require.resolve("openclaw/plugin-sdk/" + name));
    }
    let release;
    const acknowledgement = new Promise((resolve) => { release = resolve; });
    let held = false;
    let run;
    async function deliver(payload, kind) {
      const captured = JSON.parse(JSON.stringify(payload));
      const urls = [...new Set([captured.mediaUrl, ...(captured.mediaUrls || [])].filter(Boolean))];
      const media = urls.map((file) => {
        const bytes = fs.readFileSync(file);
        return { path: file, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
      });
      const sequence = trace.events.filter((event) => event.stage === "entered").length + 1;
      trace.events.push({ stage: "entered", sequence, kind, payload: captured, media });
      if (!held && media.some((item) => item.sha256 === settings.preludeSha256)) {
        held = true;
        await acknowledgement;
      }
      trace.events.push({ stage: "accepted", sequence, kind, payload: captured, media });
      return inbound.createAcceptedChannelDeliveryResult({
        results: [{ channel: id, messageId: "physical-" + sequence }],
        kind: urls.length ? "media" : "text", replyToId: captured.replyToId, content: captured.text,
      });
    }
    api.registerChannel({ plugin: {
      id,
      meta: { id, label: "Settlement proof", selectionLabel: "Settlement proof", docsPath: "/channels/settlement-proof", blurb: "Synthetic transport for Gateway settlement proof." },
      capabilities: { chatTypes: ["direct"], media: true, tts: { voice: { synthesisTarget: "audio-file", audioFileFormats: ["mp3"] } } },
      config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default" }), isEnabled: () => true, isConfigured: () => true },
      gateway: {
        async startAccount({ accountId, abortSignal, setStatus }) {
          setStatus({ accountId, lifecycle: "ready", connected: true });
          await outbound.waitUntilAbort(abortSignal);
        },
      },
      message: outbound.defineChannelMessageAdapter({
        id, durableFinal: { capabilities: { text: true, media: true, payload: true, replyTo: true } },
        send: { payload: (ctx) => deliver(ctx.payload, "adapter") },
      }),
    } });
    api.registerTool({
      name: "proof_prepare", label: "Prepare proof", description: "Prepare the synthetic report.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: "text", text: "Report ready." }], details: {} }),
    });
    api.registerSpeechProvider({
      id: "settlement-speech", label: "Synthetic speech boundary", isConfigured: () => true,
      synthesize: async ({ text, target }) => {
        trace.synthesis.push({ text, target });
        return { audioBuffer: fs.readFileSync(settings.audio), outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: false };
      },
    });
    api.registerGatewayMethod("settlement-proof.trace", ({ respond }) => respond(true, trace), { scope: "operator.admin" });
    api.registerGatewayMethod("settlement-proof.release", ({ respond }) => { release(); respond(true, { released: true }); }, { scope: "operator.admin" });
    api.registerGatewayMethod("settlement-proof.run", async ({ respond }) => {
      if (run) throw new Error("The synthetic turn is once-only");
      run = (async () => {
        const peer = "synthetic-sender";
        const { route, buildEnvelope } = inbound.resolveChannelInboundRouteEnvelope({ cfg, channel: id, accountId: "default", peer: { kind: "direct", id: peer } });
        trace.sessionKey = route.sessionKey;
        const access = await ingress.resolveStableChannelMessageIngress({
          cfg, channelId: id, accountId: "default", identity: { key: "sender", entryIdPrefix: "proof-entry" },
          subject: { stableId: peer }, conversation: { kind: "direct", id: peer },
          contextBinding: { agentId: route.agentId, sessionKey: route.sessionKey, messageId: "current-inbound", inboundEventKind: "user_request" },
          dmPolicy: "allowlist", allowFrom: [peer], groupPolicy: "disabled",
        });
        if (access.ingress.admission !== "dispatch") throw new Error("Synthetic ingress was not admitted");
        const body = "Prepare the report with proof_prepare, then return the requested final output.";
        const ctxPayload = api.runtime.channel.inbound.buildContext({
          channel: id, accountId: "default", messageId: "current-inbound", messageIdFull: "current-inbound", timestamp: Date.now(),
          from: peer, sender: { id: peer }, conversation: { kind: "direct", id: peer },
          route: { agentId: route.agentId, dmScope: route.dmScope, accountId: "default", routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
          reply: { to: peer, originatingTo: peer },
          message: { rawBody: body, bodyForAgent: body, commandBody: body, body: buildEnvelope({ channel: "Settlement proof", from: peer, body }) },
          channelIngress: access, access: { commands: { authorized: true } },
        });
        await api.runtime.channel.inbound.dispatch({
          cfg, channel: id, accountId: "default", route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey }, ctxPayload,
          delivery: { deliver: (payload, info) => deliver(payload, info.kind), observeMessageSent: true },
          replyOptions: { disableBlockStreaming: true },
          record: { onRecordError: (error) => { throw error; } },
        });
        trace.settled = true;
      })();
      await run;
      respond(true, { settled: true });
    }, { scope: "operator.admin" });
    if (!api.lifecycle.onDispose) throw new Error("Plugin disposal contract unavailable");
    api.lifecycle.onDispose(async () => {
      release();
      const errors = [];
      try {
        if (run) await run;
      } catch (error) {
        trace.runRejected = true;
        errors.push(error);
      }
      trace.runJoined = true;
      trace.disposed = true;
      try {
        fs.writeFileSync(settings.disposal, JSON.stringify(trace));
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Synthetic run and disposal recording failed");
    });
  },
};
`;

function writePrelude(response: ServerResponse, prelude: string) {
  const text = `Preparing the report.\nMEDIA:${prelude}`;
  const message = {
    type: "message",
    id: "prelude-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const tool = {
    type: "function_call",
    id: "fc_prepare",
    call_id: "call_prepare",
    name: "proof_prepare",
    arguments: "{}",
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.created",
      response: { id: "prelude-response", object: "response", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: 1,
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      item_id: tool.id,
      output_index: 1,
      name: tool.name,
      arguments: "{}",
    },
    { type: "response.output_item.done", output_index: 1, item: tool },
    {
      type: "response.completed",
      response: {
        id: "prelude-response",
        status: "completed",
        output: [message, tool],
        usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
      },
    },
  ]);
}

export async function withReplySettlementGateway(
  tempHome: string,
  oracle: "speech" | "media" | "text",
  body: (fixture: {
    prelude: string;
    preludeSha256: string;
    finalMedia: string;
    audioSha256: string;
    expectedSdkPaths: Record<string, string>;
    start: () => Promise<unknown>;
    trace: () => Promise<ProofTrace>;
    providerToolResults: () => ReadonlyArray<{ callId?: string; output?: unknown }>;
    allowFinalResponse: () => void;
    releasePrelude: () => Promise<unknown>;
    transcript: (sessionKey: string) => Promise<unknown[]>;
  }) => Promise<void>,
) {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const owner = createQaGatewayChild();
  const audio = createPlaybackMediaFixture("mp3");
  const preludeBytes = createPlaybackMediaFixture("webm");
  const preludeSha256 = createHash("sha256").update(preludeBytes).digest("hex");
  const audioSha256 = createHash("sha256").update(audio).digest("hex");
  let files:
    | {
        root: string;
        prelude: string;
        finalMedia: string;
        disposal: string;
      }
    | undefined;
  const finalResponse = createDeferred();
  const requests: Promise<void>[] = [];
  let requestCount = 0;
  const requestErrors: unknown[] = [];
  // Tool and Gateway registrations can differ; observe results at the provider boundary.
  const providerToolResults: Array<{ callId?: string; output?: unknown }> = [];
  const providerServer = createServer((request, response) => {
    const operation = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new Error("Unexpected provider route");
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const media = files;
      if (!media) {
        throw new Error("Provider called before child workspace preparation");
      }
      requestCount++;
      const requestToolResults: Array<{ call_id?: string; output?: unknown }> =
        input.input?.filter((item: { type?: string }) => item.type === "function_call_output") ??
        [];
      providerToolResults.push(
        ...requestToolResults.map((item) => ({ callId: item.call_id, output: item.output })),
      );
      if (oracle === "text") {
        if (requestCount !== 1) {
          throw new Error("Unexpected extra provider request");
        }
        await finalResponse.promise;
        writeOpenAiResponsesText(response, {
          messageId: "final-message",
          responseId: "final-response",
          text: `[[reply_to:${AUTHORED_REPLY_ID}]]${TERMINAL_TEXT}`,
        });
      } else if (requestCount === 1) {
        if (!input.tools?.some((tool: { name?: string }) => tool.name === "proof_prepare")) {
          throw new Error("Fixture tool absent from real model request");
        }
        writePrelude(response, media.prelude);
      } else if (requestCount === 2) {
        const toolResult = requestToolResults[0];
        if (
          requestToolResults.length !== 1 ||
          toolResult?.call_id !== "call_prepare" ||
          toolResult.output !== "Report ready."
        ) {
          throw new Error("Expected one successful proof_prepare result in continuation");
        }
        console.info("Gateway settlement tool result", {
          oracle,
          output:
            typeof toolResult.output === "string"
              ? toolResult.output.slice(0, 2_000)
              : "[non-string output]",
        });
        await finalResponse.promise;
        writeOpenAiResponsesText(response, {
          messageId: "final-message",
          responseId: "final-response",
          text:
            oracle === "speech"
              ? `[[tts:text]]${SPOKEN_TEXT}[[/tts:text]]`
              : `[[reply_to:${AUTHORED_REPLY_ID}]][[audio_as_voice]]Final report.\nMEDIA:${media.finalMedia}`,
        });
      } else {
        throw new Error("Unexpected extra provider request");
      }
    })().catch((error: unknown) => {
      requestErrors.push(error);
      if (requestErrors.length === 1) {
        console.error("Gateway settlement provider contract failure", {
          oracle,
          requestCount,
          method: request.method,
          url: request.url,
          error: String(error),
        });
      }
      response.writeHead(500).end("Synthetic provider failed");
    });
    requests.push(operation);
  });
  let gateway: QaGatewayChild | undefined;
  let run: Promise<unknown> | undefined;
  await runQaGatewayFixture(
    async () => {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("No loopback provider address");
      }
      const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
      const provider = buildMockOpenAiResponsesProvider(providerBaseUrl, "settlement-fixture");
      // The capsule runner and run-vitest preflight own this dist's candidate/build provenance.
      // Run the Gateway and its native plugin SDK in that same built process graph.
      gateway = await owner.start({
        repoRoot,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist", "index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        providerBaseUrl,
        primaryModel: provider.modelRef,
        alternateModel: provider.modelRef,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "0",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        },
        mutateConfig: (cfg) => {
          const workspace = cfg.agents?.defaults?.workspace;
          if (!workspace) {
            throw new Error("QA child did not bind its workspace");
          }
          const root = path.dirname(workspace);
          const pluginDir = path.join(root, "settlement-plugin");
          files = {
            root,
            prelude: path.join(workspace, "prelude.webm"),
            finalMedia: path.join(workspace, "final.mp3"),
            disposal: path.join(root, "settlement-disposed.json"),
          };
          mkdirSync(pluginDir, { recursive: true });
          writeFileSync(files.prelude, preludeBytes);
          writeFileSync(files.finalMedia, audio);
          writeFileSync(path.join(pluginDir, "index.cjs"), CAPTURE_PLUGIN);
          writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: CHANNEL,
              activation: { onStartup: true },
              channels: [CHANNEL],
              channelConfigs: {
                [CHANNEL]: {
                  schema: { type: "object", additionalProperties: false, properties: {} },
                },
              },
              contracts: { tools: ["proof_prepare"], speechProviders: ["settlement-speech"] },
              configSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  preludeSha256: { type: "string" },
                  audio: { type: "string" },
                  disposal: { type: "string" },
                },
                required: ["preludeSha256", "audio", "disposal"],
              },
            }),
          );
          return {
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: {
                ...cfg.agents?.defaults,
                skipBootstrap: true,
                contextInjection: "never",
                heartbeat: { every: "0m" },
                models: {
                  ...cfg.agents?.defaults?.models,
                  [provider.modelRef]: {
                    ...cfg.agents?.defaults?.models?.[provider.modelRef],
                    params: {
                      ...cfg.agents?.defaults?.models?.[provider.modelRef]?.params,
                      transport: "sse",
                      openaiWsWarmup: false,
                    },
                  },
                },
              },
              entries: {
                ...cfg.agents?.entries,
                qa: { ...cfg.agents?.entries?.qa, tools: { allow: ["proof_prepare"] } },
              },
            },
            tools: { allow: ["proof_prepare"], codeMode: { enabled: false } },
            messages: { visibleReplies: "automatic" },
            models: {
              ...cfg.models,
              providers: { ...cfg.models?.providers, [provider.providerId]: provider.config },
            },
            tts: {
              enabled: oracle !== "text",
              provider: "settlement-speech",
              auto: oracle === "speech" ? "tagged" : "off",
              mode: "final",
            },
            plugins: {
              ...cfg.plugins,
              enabled: true,
              allow: [...new Set([...(cfg.plugins?.allow ?? []), CHANNEL])],
              load: {
                ...cfg.plugins?.load,
                paths: [...(cfg.plugins?.load?.paths ?? []), pluginDir],
              },
              entries: {
                ...cfg.plugins?.entries,
                [CHANNEL]: {
                  enabled: true,
                  config: { preludeSha256, audio: files.finalMedia, disposal: files.disposal },
                },
              },
              slots: { ...cfg.plugins?.slots, memory: "none" },
            },
          };
        },
      });
      const child = gateway;
      const media = files;
      if (
        !media ||
        child.workspaceDir !== path.dirname(media.prelude) ||
        child.tempRoot !== media.root
      ) {
        throw new Error("Child workspace binding changed during startup");
      }
      const expectedSdkPaths = Object.fromEntries(
        await Promise.all(
          SDK_SUBPATHS.map(async (name) => [
            name,
            await fs.realpath(path.join(repoRoot, "dist/plugin-sdk", name + ".js")),
          ]),
        ),
      );
      await body({
        prelude: media.prelude,
        preludeSha256,
        finalMedia: media.finalMedia,
        audioSha256,
        expectedSdkPaths,
        start: () => {
          if (run) {
            throw new Error("Run already started");
          }
          run = child.call("settlement-proof.run", {}, { timeoutMs: 60_000 });
          void run.catch(() => undefined);
          return run;
        },
        trace: () => child.call("settlement-proof.trace", {}) as Promise<ProofTrace>,
        providerToolResults: () =>
          providerToolResults.map(({ callId, output }) => ({ callId, output })),
        allowFinalResponse: () => finalResponse.resolve(),
        releasePrelude: () => child.call("settlement-proof.release", {}),
        transcript: async (sessionKey) => {
          const entry = loadSessionEntry({
            sessionKey,
            env: child.runtimeEnv,
            readConsistency: "latest",
          });
          return entry?.sessionId
            ? readSessionTranscriptEvents({
                sessionId: entry.sessionId,
                sessionKey,
                env: child.runtimeEnv,
              })
            : [];
        },
      });
      if (requestCount !== (oracle === "text" ? 1 : 2) || requestErrors.length) {
        throw new AggregateError(requestErrors, "Unexpected Responses exchange");
      }
    },
    async () => {
      finalResponse.resolve();
      if (gateway) {
        await gateway.call("settlement-proof.release", {});
      }
    },
    async () => {
      if (run) {
        await run;
      }
    },
    async () => {
      await stopQaGatewayFixture(owner, { keepTemp: true });
    },
    async () => {
      if (gateway && files) {
        const result: ProofTrace = JSON.parse(await fs.readFile(files.disposal, "utf8"));
        if (!result.disposed || !result.runJoined) {
          throw new Error("Plugin run/disposal did not join");
        }
      }
    },
    async () => {
      if (files) {
        await closeQaRuntimeStores(files.root);
      }
    },
    async () => {
      providerServer.closeAllConnections();
      if (providerServer.listening) {
        await new Promise<void>((resolve, reject) => {
          providerServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await Promise.all(requests);
    },
    async () => {
      if (gateway) {
        const diagnostics = path.join(repoRoot, ".artifacts/130722-gateway-red");
        await fs.mkdir(diagnostics, { recursive: true });
        await fs.writeFile(
          path.join(diagnostics, path.basename(tempHome) + ".gateway.log"),
          gateway.logs(),
        );
      }
    },
  );
  // Reached only after the body and every cleanup succeeded.
  if (gateway) {
    await fs.rm(gateway.tempRoot, { recursive: true, force: true });
  }
}
