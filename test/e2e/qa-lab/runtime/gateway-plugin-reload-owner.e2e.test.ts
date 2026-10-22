import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resolvePluginArtifactDeclaredSurface } from "../../../../src/plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../../../../src/plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../../src/plugins/capability-summary.js";
import { seedInstalledPluginIndex } from "../../../../src/plugins/test-helpers/installed-plugin-index.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";
import { resetGatewayState } from "./gateway-startup-routing.test-support.js";

// Real WebChat admission, plugin replacement and resumed tool execution; only model HTTP is synthetic.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetGatewayState);
afterEach(resetGatewayState);
type ProbeResult = {
  record: string;
  sessionKey: string;
  sessionId: string;
  generation: number;
  owner: boolean;
  audience: string;
};
type Body = {
  instructions?: string;
  tools?: Array<{ name?: string }>;
  input: Array<{
    role?: string;
    type?: string;
    call_id?: string;
    output?: string;
    content?: unknown;
  }>;
};
function writeToolCall(
  response: ServerResponse,
  name: string,
  id: string,
  args: Record<string, unknown>,
) {
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: "call_" + id,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}
function result(body: Body, id: string): string {
  const output = body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === "call_" + id,
  )?.output;
  assert(output !== undefined, "Missing actual tool result " + id);
  return output;
}
it(
  "executes owner-private and Gateway tools after actual plugin replacement without another owner message",
  { timeout: 120_000 },
  async ({ signal, onTestFinished }) => {
    const home = tempDirs.make("openclaw-real-reload-owner-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const bundledPluginsDir = path.join(home, "empty-bundled");
    const pluginRoot = path.join(home, "owner-probe");
    const configPath = path.join(stateDir, "openclaw.json");
    const generations = path.join(home, "generations.txt");
    await Promise.all(
      [stateDir, workspaceDir, bundledPluginsDir, pluginRoot].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const token = randomUUID();
    await fs.writeFile(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "owner-probe",
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "owner-probe",
        kind: "memory",
        contracts: { tools: ["owner_probe"] },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "index.cjs"),
      `module.exports = { id: "owner-probe", kind: "memory", register(api) {
 // A native slot makes the host mint audiences; no real records are loaded.
 api.registerMemoryCapability({ providerRuntime: { open: async () => ({ provider: null }) } });
 const fs = require("node:fs"); const file = ${JSON.stringify(generations)};
 const generation = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
 fs.writeFileSync(file, String(generation));
 api.registerTool({ contextVersion: 2, create(context) {
  if (context.senderIsOwner !== true) throw new Error("Live authenticated private owner session required");
  context.assertInvocationCurrent();
  if (context.sessionKey !== ${JSON.stringify(sessionKey)} || !context.sessionId || context.sandboxed) throw new Error("Exact live unsandboxed owner session incarnation required");
  if (context.memoryAudience?.kind !== "owner-private") throw new Error("Current private-agent Memory audience required");
  context.assertMemoryAudienceCurrent();
  return { name: "owner_probe", label: "Owner probe", description: "Read synthetic owner-only record", parameters: { type: "object", properties: {} },
   async execute() { context.assertInvocationCurrent(); context.assertMemoryAudienceCurrent();
    return { content: [{ type: "text", text: JSON.stringify({ record: "synthetic owner record", sessionKey: context.sessionKey, sessionId: context.sessionId, generation, owner: context.senderIsOwner, audience: context.memoryAudience.kind }) }] };
   }
  };
 } }, { name: "owner_probe" });
} };`,
    );
    const failure = createDeferred<Error>();
    const delivered = createDeferred();
    const observe = <T>(work: Promise<T>) =>
      withinTest(
        Promise.race([
          work,
          failure.promise.then((error) => {
            throw error;
          }),
        ]),
        signal,
      );
    let step = 0;
    let first: ProbeResult | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    const env = {
      ...isolatedGatewayEnv,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const scenario = withEnvAsync(env, async () => {
      try {
        provider = await startOpenAiResponsesModelServer({
          modelId: "qa-reload-owner",
          bindError: "provider bind failed",
          onRequest: async (request, response) => {
            try {
              const body = JSON.parse(await readBody(request)) as Body;
              const reply = (text: string) =>
                writeOpenAiResponsesText(response, {
                  text,
                  messageId: "m-" + step,
                  responseId: "r-" + step,
                });
              if (
                JSON.stringify([
                  body.instructions,
                  ...body.input.filter(
                    (item) => item.role === "developer" || item.role === "system",
                  ),
                ]).includes("Generate a concise session title")
              ) {
                reply("Reload proof");
                return;
              }
              switch (step++) {
                case 0:
                  expect(
                    body.tools?.some((tool) => tool.name === "owner_probe"),
                    "Initial authenticated owner tool should be available",
                  ).toBe(true);
                  writeToolCall(response, "owner_probe", "initial", {});
                  break;
                case 1: {
                  const output = result(body, "initial");
                  first = JSON.parse(output) as ProbeResult;
                  expect(first).toMatchObject({
                    record: "synthetic owner record",
                    sessionKey,
                    sessionId: expect.any(String),
                    owner: true,
                    audience: "owner-private",
                    generation: expect.any(Number),
                  });
                  writeToolCall(response, "plugins", "reload", {
                    action: "reloadAndResume",
                    pluginId: "owner-probe",
                  });
                  break;
                }
                case 2:
                  expect(
                    body.tools?.some((tool) => tool.name === "owner_probe"),
                    "Resumed authenticated owner tool should remain available",
                  ).toBe(true);
                  expect(JSON.stringify(body.input)).toContain("Plugin reload result");
                  writeToolCall(response, "owner_probe", "resumed", {});
                  break;
                case 3: {
                  const second = JSON.parse(result(body, "resumed")) as ProbeResult;
                  assert(first);
                  expect(second).toMatchObject({ ...first, generation: expect.any(Number) });
                  expect(second.generation).toBeGreaterThan(first.generation);
                  writeToolCall(response, "plugins", "resumed-inspect", {
                    action: "inspect",
                    pluginId: "owner-probe",
                  });
                  break;
                }
                case 4: {
                  const inspection = JSON.parse(result(body, "resumed-inspect")) as {
                    ok: boolean;
                    plugin: { id: string; enabled: boolean };
                  };
                  expect(inspection).toMatchObject({
                    ok: true,
                    plugin: { id: "owner-probe", enabled: true },
                  });
                  reply(
                    "Owner-only read and Gateway inspection succeeded after actual plugin reload.",
                  );
                  break;
                }
                default:
                  throw new Error("Unexpected provider request " + step);
              }
            } catch (error) {
              failure.resolve(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
          },
        });
        const cfg = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId: "qa-reload-owner",
          reasoning: false,
          toolProfile: "full",
        });
        cfg.agents!.defaults!.workspace = workspaceDir;
        cfg.agents!.defaults!.models = {
          "mock-openai/qa-reload-owner": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        };
        cfg.agents!.entries = { main: {} };
        cfg.plugins = {
          slots: { memory: "owner-probe" },
          enabled: true,
          allow: ["owner-probe"],
          load: { paths: [pluginRoot] },
        };
        cfg.tools = { allow: ["plugins", "owner_probe"], codeMode: false, toolSearch: false };
        cfg.gateway = { auth: { mode: "token", token } };
        await fs.writeFile(configPath, JSON.stringify(cfg));
        await seedInstalledPluginIndex(
          { "owner-probe": { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } },
          { env: process.env, config: cfg },
        );
        await resolvePluginCapabilityConsent({
          config: cfg,
          pluginId: "owner-probe",
          env: process.env,
          acknowledge: {
            reviewToken: computeDeclaredSurfaceHash(
              resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, { config: cfg }),
            ),
          },
        });
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          origin: "http://127.0.0.1",
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          scopes: ["operator.admin"],
          onEvent: (event) => {
            if (
              event.event === "chat" &&
              JSON.stringify(event.payload).includes(
                "Owner-only read and Gateway inspection succeeded after actual plugin reload.",
              ) &&
              (event.payload as { state?: string })?.state === "final"
            ) {
              delivered.resolve();
            }
          },
        });
        await gateway.server.startupSettled;
        const runtime = getRuntimeConfigSnapshot();
        assert(runtime);
        withFastReplyConfig(runtime);
        await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message:
            "Read my synthetic owner record, reload owner-probe, and read it again automatically.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await observe(delivered.promise);
        const history = await gateway.client.request<{ sessionId: string; messages: unknown[] }>(
          "chat.history",
          { sessionKey },
        );
        assert(first);
        expect(history.sessionId).toBe(first.sessionId);
        expect(JSON.stringify(history.messages)).toContain(
          "Owner-only read and Gateway inspection succeeded after actual plugin reload.",
        );
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "Isolated reload owner proof complete" });
            }
          }
        } finally {
          await provider?.close();
        }
      }
    });
    onTestFinished(async () => {
      await Promise.allSettled([scenario]);
    });
    return scenario;
  },
);
