import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { readMockRequests, useMediaGateway } from "../media/media-gateway.test-support.js";
import { listen } from "../media/media-http.test-support.js";
import { withFixturePlugin } from "./fixture-plugin-config.js";

const ACTIVE_MODEL = "gpt-5.6-luna";
const MODEL = "fixture-vision";
const MARKER = "IMAGE_IDENTITY_CHANNEL_PROOF";
const FINAL_REPLY = "QA_IMAGE_IDENTITY_OK";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const PLUGIN = "image-identity-fixture";
const SUMMARY = "Synthetic provider summary: red above blue.";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Owner = "google" | "gemini";
type Mode = "native" | "model-only" | "legacy";
const credential = (owner: Owner) => "synthetic-image-proof-" + owner;
type NativeCall = {
  handler: Owner;
  provider: string;
  model: string;
  mime: string;
  bytes: number;
  sha256: string;
};
type WireCall = {
  method: string;
  path: string;
  model?: string;
  credential: Owner | "none" | "unknown";
  images: Array<{ mime: string; bytes: number; sha256: string }>;
};

// Observe every request, not only inference. Never store headers or credential values.
async function startImageEndpoint(owner: Owner) {
  const calls: WireCall[] = [];
  const errors: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const auth = request.headers.authorization;
      const call: WireCall = {
        method: request.method ?? "",
        path: request.url ?? "",
        images: [],
        credential: !auth
          ? "none"
          : auth === "Bearer " + credential("google")
            ? "google"
            : auth === "Bearer " + credential("gemini")
              ? "gemini"
              : "unknown",
      };
      calls.push(call);
      const raw = await text(request);
      const body = raw ? JSON.parse(raw) : {};
      call.model = body.model;
      for (const item of body.input ?? []) {
        for (const content of item.content ?? []) {
          if (content.type !== "input_image") {
            continue;
          }
          const match = /^data:([^;]+);base64,(.+)$/s.exec(content.image_url ?? "");
          if (!match) {
            throw new Error("expected inline synthetic image at final provider boundary");
          }
          const bytes = Buffer.from(match[2]!, "base64");
          call.images.push({ mime: match[1]!, bytes: bytes.length, sha256: digest(bytes) });
        }
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new Error("unexpected image-provider route");
      }
      writeOpenAiResponsesText(response, {
        text: SUMMARY,
        messageId: "msg_" + owner,
        responseId: "resp_" + owner,
      });
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "text/plain" });
      }
      response.end("synthetic image endpoint rejected request");
    });
  });
  const listener = await listen(server);
  return { ...listener, calls, errors };
}

// Native handlers delegate to the PUBLIC built SDK generic image helper. Unlike the
// original stub, real model/auth resolution and HTTP egress must now complete.
async function writeProviderFixture(root: string, mode: Mode, toolPath: boolean) {
  const pluginDir = path.join(root, PLUGIN);
  const callsPath = path.join(root, "provider-calls.jsonl");
  const harnessPath = path.join(root, "harness-events.jsonl");
  const declared = mode === "legacy" ? ["google"] : ["google", "gemini"];
  const native = mode === "native" ? declared : ["google"];
  const metadata = Object.fromEntries(
    native.map((id) => [
      id,
      {
        capabilities: ["image"],
        defaultModels: { image: MODEL },
      },
    ]),
  );
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN,
      activation: { onStartup: true },
      providers: declared,
      contracts: { mediaUnderstandingProviders: native },
      mediaUnderstandingProviderMetadata: metadata,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const source = [
    'const fs = require("node:fs");',
    'const { createHash } = require("node:crypto");',
    'const { describeImageWithModel } = require("openclaw/plugin-sdk/media-understanding");',
    'const { createAgentHarnessAssistantMessage } = require("openclaw/plugin-sdk/agent-harness-attempt-runtime");',
    "let retained;",
    "const recordHarness = (event) => fs.appendFileSync(" +
      JSON.stringify(harnessPath) +
      ', JSON.stringify(event) + "\\n");',

    "module.exports = { id: " + JSON.stringify(PLUGIN) + ", register(api) {",
    "for (const id of " + JSON.stringify(native) + ") {",
    'api.registerMediaUnderstandingProvider({ id, capabilities: ["image"],',
    "defaultModels: { image: " + JSON.stringify(MODEL) + " },",
    "async describeImage(request) {",
    "fs.appendFileSync(" + JSON.stringify(callsPath) + ", JSON.stringify({",
    "handler: id, provider: request.provider, model: request.model, mime: request.mime,",
    'bytes: request.buffer.length, sha256: createHash("sha256").update(request.buffer).digest("hex")',
    '}) + "\\n");',
    "return await describeImageWithModel(request);",
    "}}); }",
    ...(toolPath
      ? [
          'api.registerGatewayMethod("qa.imageIdentity.retained", async ({respond}) => {',
          'if (!retained) { respond(false, undefined, {code: "UNAVAILABLE", message: "no captured tool"}); return; }',
          "let hostClosed = false;",
          "try { retained.host.assertActive(); } catch { hostClosed = true; }",
          'let rejected = false; let error = "";',
          'try { await retained.tool.execute("retained-after-close", retained.args); }',
          "catch (cause) { rejected = true; error = String(cause.message ?? cause).slice(0, 500); }",
          "respond(true, {hostClosed, rejected, error});",
          "});",
          'api.registerAgentHarness({ id: "image-identity-harness", label: "Synthetic image boundary harness",',
          "supports: () => ({supported: true, priority: 100}),",
          "async runAttempt(params) {",
          "const prepared = params.preparedModelRuntime;",
          'if (!prepared?.metadataSnapshot) throw new Error("real prepared metadata was not supplied");',
          "const host = params.hostCapabilities;",
          "const tools = await host.createToolSurfaceAsync({",
          "config: params.config, agentDir: params.agentDir, workspaceDir: params.workspaceDir,",
          "sessionKey: params.sessionKey, sessionId: params.sessionId, agentId: params.agentId,",
          "modelProvider: params.provider, modelId: params.modelId,",
          "preparedModelRuntime: prepared, abortSignal: params.abortSignal, sandbox: params.sandbox,",
          "});",
          'const tool = tools.find((tool) => tool.name === "view_image");',
          'if (!tool) throw new Error("image tool missing from admitted host surface");',
          "const args = {path: " +
            JSON.stringify("data:image/png;base64," + PNG) +
            ", prompt: " +
            JSON.stringify(MARKER) +
            "};",
          "retained = {tool, args, host};",
          'recordHarness({event: "captured", policyHash: prepared.metadataSnapshot.policyHash,',
          'geminiOwners: [...(prepared.metadataSnapshot.declaredProviderOwners.get("gemini") ?? [])]});',
          'const result = await tool.execute("live-image-proof", args);',
          "if (!JSON.stringify(result).includes(" +
            JSON.stringify(SUMMARY) +
            ')) throw new Error("image tool did not return endpoint summary");',
          'recordHarness({event: "image-completed", summaryReceived: true});',
          'const assistant = createAgentHarnessAssistantMessage({api: "openai-responses", provider: params.provider, modelId: params.modelId},',
          JSON.stringify(FINAL_REPLY) + ", {aborted: false});",
          'return {terminal: {kind: "ok"}, sessionIdUsed: params.sessionId, messagesSnapshot: [assistant],',
          "assistantTexts: [" +
            JSON.stringify(FINAL_REPLY) +
            "], toolMetas: [], lastAssistant: assistant,",
          "didSendViaMessagingTool: false, messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [],",
          "cloudCodeAssistFormatError: false, replayMetadata: {hadPotentialSideEffects: true, replaySafe: false},",
          "itemLifecycle: {startedCount: 1, completedCount: 1, activeCount: 0}};",
          "}});",
        ]
      : []),
    "}};",
  ].join("\n");
  await fs.writeFile(path.join(pluginDir, "index.js"), source);
  return { pluginDir, callsPath, harnessPath, pluginSourceSha256: digest(source) };
}

async function readNativeCalls(file: string): Promise<NativeCall[]> {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("built QA channel provider identity final effects", () => {
  const fixture = useMediaGateway();
  it.each([
    { mode: "native", expected: "gemini", toolPath: false },
    { mode: "model-only", expected: "gemini", toolPath: false },
    { mode: "legacy", expected: "google", toolPath: false },
    { mode: "native", expected: "gemini", toolPath: true },
    { mode: "model-only", expected: "gemini", toolPath: true },
    // Standalone explicit imageModel retains its configured provider even without a
    // plugin owner; unchanged-base execution proves this differs from inbound aliases.
    { mode: "legacy", expected: "gemini", toolPath: true },
  ] as const)(
    "$mode final image and credential owner (host image tool: $toolPath)",
    async ({ mode, expected, toolPath }) => {
      const root = tempDirs.make("image-identity-proof-");
      const google = await startImageEndpoint("google");
      fixture.track(() => google.stop());
      const gemini = await startImageEndpoint("gemini");
      fixture.track(() => gemini.stop());
      const endpoints = { google, gemini };
      const providerFixture = await writeProviderFixture(root, mode, toolPath);
      const conversation = {
        id: "image-identity-" + mode + "-" + toolPath,
        kind: "direct" as const,
      };
      let phase = "gateway-start";
      let passed = false;
      const observations: Record<string, unknown> = {};
      try {
        const { state, transport, mock, gateway } = await fixture.start({
          primaryModel: "mock-openai/" + ACTIVE_MODEL,
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          mutateConfig(config) {
            const cfg = withFixturePlugin(config, providerFixture.pluginDir, PLUGIN);
            const providers = cfg.models!.providers!;
            const active = providers["mock-openai"]!.models.find(
              (model) => model.id === ACTIVE_MODEL,
            );
            if (!active) {
              throw new Error("maintained QA active model missing");
            }
            active.input = ["text"];
            // Both endpoints and keys exist even for legacy; metadata alone decides
            // whether the historical alias is claimed. No fallback hides misrouting.
            for (const id of ["google", "gemini"] as const) {
              providers[id] = {
                api: "openai-responses",
                baseUrl: endpoints[id].url + "/v1",
                apiKey: credential(id),
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: MODEL,
                    name: MODEL,
                    input: ["text", "image"],
                    reasoning: false,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              };
            }
            cfg.plugins!.entries = { ...cfg.plugins!.entries, google: { enabled: false } };
            cfg.agents!.defaults!.imageModel = { primary: "gemini/" + MODEL };
            if (toolPath) {
              cfg.agents!.defaults!.models = {
                ...cfg.agents!.defaults!.models,
                ["mock-openai/" + ACTIVE_MODEL]: { agentRuntime: { id: "image-identity-harness" } },
              };
            }
            cfg.tools = {
              ...cfg.tools,
              media: {
                ...cfg.tools?.media,
                models: [{ provider: "gemini", model: MODEL, capabilities: ["image"] }],
                image: {
                  enabled: !toolPath,
                  prompt: MARKER,
                },
              },
            };
            return cfg;
          },
        });
        phase = "channel-ingress";
        await transport.sendInbound({
          accountId: "default",
          conversation,
          senderId: conversation.id,
          text: MARKER + ": use the image description and reply exactly " + FINAL_REPLY + ".",
          // Offload cases stage a real channel attachment. Host-tool cases use
          // explicit synthetic SDK input; do not claim channel attachment reachability.
          ...(toolPath
            ? {}
            : {
                attachments: [
                  {
                    id: "synthetic-split-image",
                    kind: "image" as const,
                    mimeType: "image/png",
                    fileName: "red-top-blue-bottom.png",
                    contentBase64: PNG,
                  },
                ],
              }),
        });
        const finalOutbound = await transport.waitForOutbound({
          conversation,
          textIncludes: FINAL_REPLY,
          timeoutMs: 90_000,
        });
        phase = "final-effect-assertions";
        const nativeCalls = await readNativeCalls(providerFixture.callsPath);
        const ownerCalls = endpoints[expected].calls;
        const competing: Owner = expected === "gemini" ? "google" : "gemini";
        const requests = (await readMockRequests(mock.baseUrl)).filter((request) =>
          request.allInputText.includes(MARKER),
        );
        const visible = state
          .getSnapshot()
          .messages.filter(
            (message) =>
              message.direction === "outbound" &&
              message.accountId === "default" &&
              message.conversation.id === conversation.id &&
              message.conversation.kind === conversation.kind &&
              !message.deleted,
          );
        observations.mainModelRequests = requests.map((request) => ({
          model: request.model,
          imageInputCount: request.imageInputCount,
          receivedSummary: request.allInputText.includes(SUMMARY),
        }));
        observations.visibleReplyCount = visible.length;
        expect(endpoints.google.errors).toEqual([]);
        expect(endpoints.gemini.errors).toEqual([]);
        expect(
          endpoints[competing].calls,
          "competing owner must receive neither image nor credentials",
        ).toEqual([]);
        const inference = ownerCalls.filter(
          (call) => call.method === "POST" && call.path === "/v1/responses",
        );
        expect(inference).toHaveLength(1);
        expect(inference[0]).toMatchObject({
          model: MODEL,
          credential: expected,
          images: [
            {
              mime: "image/png",
              bytes: expect.any(Number),
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
        });
        expect(inference[0]!.images[0]!.bytes).toBeGreaterThan(0);
        // Every request carrying auth must use the selected owner's sentinel.
        expect(
          ownerCalls.every((call) => call.credential === "none" || call.credential === expected),
        ).toBe(true);
        if (mode === "model-only" || (mode === "legacy" && toolPath)) {
          expect(nativeCalls).toEqual([]);
        } else {
          expect(nativeCalls).toEqual([
            expect.objectContaining({ handler: expected, provider: expected, model: MODEL }),
          ]);
          expect(inference[0]!.images[0]!.sha256).toBe(nativeCalls[0]!.sha256);
        }
        if (toolPath) {
          const events = (await fs.readFile(providerFixture.harnessPath, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          observations.harness = events;
          expect(events).toHaveLength(2);
          expect(events[0]).toMatchObject({ event: "captured", policyHash: expect.any(String) });
          expect(events[0].geminiOwners.includes(PLUGIN)).toBe(mode !== "legacy");
          expect(events[1]).toEqual({ event: "image-completed", summaryReceived: true });
          expect(requests).toEqual([]);
          phase = "retained-tool-revocation";
          const before = {
            google: endpoints.google.calls.length,
            gemini: endpoints.gemini.calls.length,
          };
          // selection.ts closes the host in finally before the channel final reply.
          // Exercise the SAME retained tool once. Never retry until rejection.
          const refused = (await gateway.call("qa.imageIdentity.retained", {})) as {
            hostClosed?: boolean;
            rejected?: boolean;
            error?: string;
          };
          observations.retained = refused;
          expect(refused).toMatchObject({ hostClosed: true, rejected: true });
          expect(refused.error).toMatch(/closed|active|abort|revok|source|scope/i);
          expect({
            google: endpoints.google.calls.length,
            gemini: endpoints.gemini.calls.length,
          }).toEqual(before);
        } else {
          expect(requests).toHaveLength(1);
          expect(requests[0]!.model).toBe(ACTIVE_MODEL);
          expect(requests[0]!.imageInputCount).toBe(0);
          expect(requests[0]!.allInputText).toContain(SUMMARY);
        }
        expect(visible).toEqual([
          expect.objectContaining({ id: finalOutbound.id, text: FINAL_REPLY }),
        ]);
        passed = true;
        phase = "complete";
      } finally {
        const receipt = {
          mode,
          expected,
          toolPath,
          passed,
          phase,
          nativeCalls: await readNativeCalls(providerFixture.callsPath),
          endpoints: { google: endpoints.google.calls, gemini: endpoints.gemini.calls },
          endpointErrors: { google: endpoints.google.errors, gemini: endpoints.gemini.errors },
          ...observations,
          inputSha256: digest(Buffer.from(PNG, "base64")),
          pluginSourceSha256: providerFixture.pluginSourceSha256,
          inference: "real built transport to synthetic loopback endpoint",
          authScope: "real configured-key resolution; synthetic sentinels only",
        };
        // CI's retained regression job exposes stdout, not the external proof workflow's artifact path.
        // All observations are synthetic; credential values and request headers are never included.
        console.info("IMAGE_IDENTITY_REGRESSION_RECEIPT " + JSON.stringify(receipt));
        if (process.env.IMAGE_IDENTITY_PROOF_RECEIPTS) {
          await fs.appendFile(
            process.env.IMAGE_IDENTITY_PROOF_RECEIPTS,
            JSON.stringify(receipt) + "\n",
          );
        }
      }
    },
    180_000,
  );
});
