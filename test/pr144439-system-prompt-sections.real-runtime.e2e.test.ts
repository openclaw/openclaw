import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const BASELINE_MARKER = "PR144439_BASELINE_REQUEST";
const CUSTOM_MARKER = "PR144439_CUSTOM_REQUEST";
const INTERACTION_MARKER = "PR144439_AGENT_INTERACTION";
const EXECUTION_MARKER = "PR144439_AGENT_EXECUTION";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

type ProviderRequest = {
  instructions?: unknown;
  input?: unknown;
};

function textContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join("\n");
  }
  if (value && typeof value === "object" && "text" in value) {
    return textContent(value.text);
  }
  return "";
}

function promptInstructions(request: ProviderRequest): string {
  const input = Array.isArray(request.input) ? request.input : [];
  return [
    textContent(request.instructions),
    ...input.flatMap((item: unknown) =>
      item &&
      typeof item === "object" &&
      "role" in item &&
      "content" in item &&
      (item.role === "developer" || item.role === "system")
        ? [textContent(item.content)]
        : [],
    ),
  ].join("\n");
}

function writeAssistantResponse(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "pr144439-proof-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "PR144439_RUNTIME_OK", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "pr144439-proof-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

describe("PR #144439 real system-prompt section behavior", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "delivers per-agent overrides to the model while preserving the default agent prompt",
    { timeout: 300_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const providerRequests: ProviderRequest[] = [];
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr144439-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);

        const token = "pr144439-proof-token";
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            providerRequests.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest,
            );
            writeAssistantResponse(response);
          })().catch((error: unknown) => {
            response.writeHead(500).end(error instanceof Error ? error.message : String(error));
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "gpt-pr144439-proof",
        );
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: {
              main: { default: true },
              custom: {
                systemPrompt: {
                  sections: {
                    interaction_style: { mode: "replace", content: INTERACTION_MARKER },
                    tool_call_style: { mode: "disable" },
                    execution_bias: { mode: "append", content: EXECUTION_MARKER },
                  },
                },
              },
            },
          },
          tools: { profile: "coding" },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "pr144439-real-runtime-proof",
        });
        process.stdout.write("PR144439_PROOF gateway-ready\n");

        for (const [agentId, marker] of [
          ["main", BASELINE_MARKER],
          ["custom", CUSTOM_MARKER],
        ] as const) {
          process.stdout.write(`PR144439_PROOF dispatch-${agentId}\n`);
          const started = await gateway.client.request<{ runId?: string; status?: string }>(
            "chat.send",
            {
              sessionKey: `agent:${agentId}:pr144439-proof`,
              message: marker,
              deliver: false,
              idempotencyKey: `pr144439-${agentId}`,
            },
          );
          expect(started.status).toBe("started");
          expect(started.runId).toEqual(expect.any(String));
          await expect(
            gateway.client.request(
              "agent.wait",
              { runId: started.runId, timeoutMs: 30_000 },
              { timeoutMs: 35_000 },
            ),
          ).resolves.toMatchObject({ status: "ok" });
          process.stdout.write(`PR144439_PROOF complete-${agentId}\n`);
        }

        const baselineRequest = providerRequests.find((request) =>
          JSON.stringify(request.input).includes(BASELINE_MARKER),
        );
        const customRequest = providerRequests.find((request) =>
          JSON.stringify(request.input).includes(CUSTOM_MARKER),
        );
        expect(baselineRequest).toBeDefined();
        expect(customRequest).toBeDefined();
        const baselineInstructions = promptInstructions(baselineRequest ?? {});
        const customInstructions = promptInstructions(customRequest ?? {});

        expect(baselineInstructions).toContain("## Tool Call Style");
        expect(baselineInstructions).toContain("## Execution Bias");
        expect(baselineInstructions).toContain("exec approval-pending:");
        expect(baselineInstructions).toContain("## Safety");
        expect(baselineInstructions).not.toContain(INTERACTION_MARKER);
        expect(baselineInstructions).not.toContain(EXECUTION_MARKER);
        expect(customInstructions).toContain(INTERACTION_MARKER);
        expect(customInstructions).not.toContain("## Interaction Style");
        expect(customInstructions).not.toContain("## Tool Call Style");
        expect(customInstructions).toContain("## Execution Bias");
        expect(customInstructions).toContain(EXECUTION_MARKER);
        expect(customInstructions).toContain("exec approval-pending:");
        expect(customInstructions).toContain("## Safety");
        process.stdout.write("PR144439_PROOF assertions-passed\n");

        process.stdout.write(
          `${JSON.stringify({
            kind: "real-gateway-loopback-model-request",
            providerRequests: providerRequests.length,
            baseline: {
              defaultToolCallStyle: baselineInstructions.includes("## Tool Call Style"),
              defaultExecutionBias: baselineInstructions.includes("## Execution Bias"),
              approvalGuidancePresent: baselineInstructions.includes("exec approval-pending:"),
              safetyPresent: baselineInstructions.includes("## Safety"),
              customMarkersAbsent:
                !baselineInstructions.includes(INTERACTION_MARKER) &&
                !baselineInstructions.includes(EXECUTION_MARKER),
            },
            custom: {
              interactionReplaced: customInstructions.includes(INTERACTION_MARKER),
              toolCallStyleDisabled: !customInstructions.includes("## Tool Call Style"),
              executionBiasAppended: customInstructions.includes(EXECUTION_MARKER),
              approvalGuidancePreserved: customInstructions.includes("exec approval-pending:"),
              safetyPreserved: customInstructions.includes("## Safety"),
            },
          })}\n`,
        );
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
