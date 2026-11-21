import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Agent, fetch } from "undici";
import type { ArtifactsDownloadResult } from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { listMediaGenerationOperations } from "../../src/agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../src/agents/media-generation-activity.test-support.js";
import { createImageGenerateTool } from "../../src/agents/tools/image-generate-tool.js";
import { captureRuntimeConfigAsyncReader } from "../../src/config/io.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/client.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import { KERNEL_TEST_ENV } from "../../src/gateway/test-helpers.env.js";
import { startClaimedGateway } from "../../src/gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./gateway-client.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

type LiveProofOptions = {
  getMediaOpenCount?: () => number;
};

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function proofLog(message: string): void {
  if (process.env.OPENCLAW_MEDIA_RETENTION_PROOF === "1") {
    process.stdout.write(`[media-retention-proof] ${message}\n`);
  }
}

/** Run the production image-generation, blocked-delivery, Gateway-history, and download path. */
export async function runMediaRetentionLiveProof(options: LiveProofOptions = {}): Promise<void> {
  await withOpenClawTestState(
    {
      label: "blocked-media-gateway-proof",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    },
    async (state) => {
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const token = "synthetic-blocked-media-gateway-token";
      const certPath = state.statePath("tls", "cert.pem");
      const keyPath = state.statePath("tls", "key.pem");
      const sessionKey = "agent:main:blocked-media-gateway";
      const sessionId = "blocked-media-gateway-session";
      const scope = { agentId: "main", sessionKey, sessionId, env: state.env };
      const providerId = "blocked-media-proof";
      const pluginDir = state.statePath("plugins", providerId);
      const pluginPath = path.join(pluginDir, "index.cjs");
      const pluginKey = `__openclaw_${providerId}_${Date.now()}`;
      const providerState: { calls: number; model?: string; onGenerate?: () => void } = {
        calls: 0,
      };
      Object.defineProperty(globalThis, pluginKey, { configurable: true, value: providerState });
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        pluginPath,
        `const fixture = globalThis[${JSON.stringify(pluginKey)}];
module.exports = {
  id: ${JSON.stringify(providerId)},
  register(api) {
    api.registerImageGenerationProvider({
      id: ${JSON.stringify(providerId)},
      defaultModel: "fixture-image",
      isConfigured: () => true,
      capabilities: { generate: { maxCount: 1 }, edit: { enabled: false, maxInputImages: 0 } },
      async generateImage(request) {
        fixture.calls++;
        fixture.model = request.model;
        fixture.onGenerate?.();
        return {
          images: [{
            buffer: Buffer.from(${JSON.stringify(IMAGE_BASE64)}, "base64"),
            mimeType: "image/png",
            fileName: "generated.png",
          }],
        };
      },
    });
  },
};
`,
      );
      await writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        `${JSON.stringify(
          {
            id: providerId,
            contracts: { imageGenerationProviders: [providerId] },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          null,
          2,
        )}\n`,
      );

      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let dispatcher: Agent | undefined;
      const clients: GatewayClient[] = [];
      await runQaGatewayFixture(
        async () => {
          const config: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                mediaModels: { image: { primary: `${providerId}/fixture-image` } },
              },
            },
            plugins: {
              allow: [providerId],
              load: { paths: [pluginPath] },
              slots: { memory: "none" },
            },
            gateway: {
              roles: {
                default: "view",
                definitions: {
                  view: {
                    sessions: { others: "view" },
                    agents: "*",
                    scopes: ["operator.read", "operator.write"],
                  },
                },
              },
              auth: { mode: "token", token },
              controlUi: { enabled: false, basePath: "/gateway" },
              tls: { enabled: true, certPath, keyPath },
            },
          };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);
          await captureRuntimeConfigAsyncReader()();
          await replaceSessionEntry(scope, {
            sessionId,
            updatedAt: 1,
            visibility: "shared",
          });
          providerState.onGenerate = () =>
            setRuntimeConfigSnapshot({
              ...config,
              session: {
                ...config.session,
                store: state.statePath("unavailable-session-store.json"),
              },
            });

          server = await startClaimedGateway(claim, () =>
            startGatewayServer(claim.port, {
              bind: "loopback",
              auth: { mode: "token", token },
              controlUiEnabled: false,
              sidecarStartup: "defer",
            }),
          );
          const imageTool = createImageGenerateTool(
            {
              config,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              agentSessionKey: sessionKey,
              requesterAgentId: "main",
              requesterOrigin: {
                channel: "discord",
                accountId: "default",
                to: "user:blocked-media-proof",
              },
            },
            true,
          );
          assert(imageTool, "Expected the configured image-generation tool");
          const started = await imageTool.execute("blocked-media-generation", {
            prompt: "A synthetic lighthouse at dusk",
          });
          const details = started.details;
          assert(
            isRecord(details) && typeof details.runId === "string",
            "image_generate should start a background task",
          );
          const runId = details.runId;
          const generationDeadline = Date.now() + 20_000;
          let operation = listMediaGenerationOperations(sessionKey, "main").find(
            (entry) => entry.runId === runId,
          );
          while (operation?.status !== "succeeded" && Date.now() < generationDeadline) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 25);
            });
            operation = listMediaGenerationOperations(sessionKey, "main").find(
              (entry) => entry.runId === runId,
            );
          }
          setRuntimeConfigSnapshot(config);
          assert.equal(providerState.calls, 1);
          assert.equal(providerState.model, "fixture-image");
          assert(operation);
          assert.equal(operation.status, "succeeded");
          assert.equal(operation.terminalOutcome, "blocked");
          proofLog(
            `generation=${providerState.model} provider_calls=${providerState.calls} delivery_queue=unavailable completion=${operation.terminalOutcome}`,
          );

          const cert = await readFile(certPath, "utf8");
          dispatcher = new Agent({ connect: { ca: cert, servername: "openclaw-gateway" } });
          const origin = `https://127.0.0.1:${claim.port}`;
          const connect = async (label: string, scopes: string[]) => {
            const client = await acquireGatewayTestClient(
              {
                url: `wss://127.0.0.1:${claim.port}`,
                token,
                tlsFingerprint: new X509Certificate(cert).fingerprint256,
                clientName: "test",
                mode: "test",
                scopes,
                deviceIdentity: loadOrCreateDeviceIdentity({
                  path: state.statePath(label, "client", "credentials.sqlite"),
                }),
              },
              {
                timeoutMs: 10_000,
                timeoutMessage: "TLS Gateway connect timed out",
                closeMessage: "TLS Gateway closed",
              },
            );
            clients.push(client);
            return client;
          };
          const reader = await connect("allowed-reader", ["operator.read"]);
          const unscopedReader = await connect("unscoped-reader", ["operator.approvals"]);
          const opensBeforeDeniedRequest = options.getMediaOpenCount?.();
          await assert.rejects(
            unscopedReader.request("chat.history", { sessionKey }),
            /missing scope: operator\.read/,
          );
          if (opensBeforeDeniedRequest !== undefined) {
            assert.equal(options.getMediaOpenCount?.(), opensBeforeDeniedRequest);
          }

          const history = await reader.request<{ messages?: unknown[] }>("chat.history", {
            sessionKey,
          });
          const retained = (history.messages ?? []).find(
            (message) =>
              isRecord(message) &&
              message.role === "assistant" &&
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  isRecord(block) &&
                  block.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.includes("completion delivery"),
              ),
          );
          const content =
            isRecord(retained) && Array.isArray(retained.content) ? retained.content : [];
          const image = content.find((block) => isRecord(block) && block.type === "image");
          proofLog(
            `history=reopened image_blocks=${content.filter((block) => isRecord(block) && block.type === "image").length}`,
          );
          assert(isRecord(image) && typeof image.artifactId === "string");
          const artifactId = image.artifactId;
          const download = await reader.request<ArtifactsDownloadResult>("artifacts.download", {
            sessionKey,
            artifactId,
            transport: "http",
          });
          assert(download.url);
          const request = async (url: string) => {
            const response = await fetch(new URL(url, origin), { dispatcher });
            return {
              status: response.status,
              bytes: Buffer.from(await response.arrayBuffer()),
            };
          };
          const served = await request(download.url);
          assert.equal(served.status, 200);
          assert.equal(served.bytes.toString("base64"), IMAGE_BASE64);
          proofLog(
            `authenticated_download=status_${served.status} bytes=${served.bytes.byteLength}`,
          );

          const opensBeforeRevocation = options.getMediaOpenCount?.();
          await replaceSessionEntry(scope, {
            sessionId,
            updatedAt: 2,
            visibility: "draft",
          });
          const revoked = await request(download.url);
          assert.equal(revoked.status, 404);
          if (opensBeforeRevocation !== undefined) {
            assert.equal(options.getMediaOpenCount?.(), opensBeforeRevocation);
          }
          proofLog(
            `negative_controls=scope_denied ticket_revoked_404${options.getMediaOpenCount ? "_before_file_io" : ""}`,
          );
        },
        async () => {
          for (const client of clients) {
            await client.stopAndWait();
          }
        },
        async () => dispatcher?.close(),
        async () => server?.close({ reason: "blocked media Gateway proof complete" }),
        () => claim.release(),
        () => resetGeneratedMediaTaskActivityForTests(),
        () => Reflect.deleteProperty(globalThis, pluginKey),
      );
    },
  );
}
