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

// Real WebChat turn, real external plugins.reload and real step-boundary handover; only model
// HTTP is synthetic. Each step calls a slow plugin tool that reports its plugin generation.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const STEPS = 6;
const STEP_MS = 1_500;
const RELOAD_AFTER_STEP = 2;
const FINAL_REPLY = "All handover steps done.";
beforeEach(resetGatewayState);
afterEach(resetGatewayState);

type Body = {
  instructions?: string;
  input: Array<Partial<Record<"role" | "type" | "call_id" | "output", string>>>;
};
type Step = { step: number; plugin: string; generation: number; atMs: number };
type Scenario = {
  name: string;
  plugins: Array<{ id: string; turnHandover: boolean }>;
  handsOver: boolean;
};

function writeToolCall(response: ServerResponse, name: string, id: string) {
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: "call_" + id,
    name,
    arguments: "{}",
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
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

async function writePlugin(home: string, id: string, turnHandover: boolean, counts: string) {
  const root = path.join(home, id);
  const tool = id.replaceAll("-", "_") + "_step";
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { tools: [tool] },
      ...(turnHandover ? { reload: { turnHandover: true } } : {}),
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(root, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {
 const fs = require("node:fs"); const file = ${JSON.stringify(path.join(home, id + ".generation"))};
 const generation = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
 fs.writeFileSync(file, String(generation));
 api.on("agent_end", () => { fs.appendFileSync(${JSON.stringify(counts)}, "agent_end\\n"); });
 api.registerTool({ name: ${JSON.stringify(tool)}, label: "Step", description: "Slow step", parameters: { type: "object", properties: {} },
  async execute() { await new Promise((r) => setTimeout(r, ${STEP_MS}));
   return { content: [{ type: "text", text: JSON.stringify({ plugin: ${JSON.stringify(id)}, generation }) }] }; } },
  { name: ${JSON.stringify(tool)} });
} };`,
  );
  return { id, root, tool };
}

const scenarios: Scenario[] = [
  { name: "declared", plugins: [{ id: "swap-proof", turnHandover: true }], handsOver: true },
  { name: "undeclared", plugins: [{ id: "swap-proof", turnHandover: false }], handsOver: false },
  {
    name: "mixed reload",
    plugins: [
      { id: "swap-proof", turnHandover: true },
      { id: "pinned-proof", turnHandover: false },
    ],
    handsOver: false,
  },
];

it.for(scenarios)(
  "plugin reload during a running turn: $name",
  { timeout: 180_000 },
  async ({ name, plugins, handsOver }, { signal, onTestFinished }) => {
    const home = tempDirs.make("openclaw-turn-handover-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const bundledPluginsDir = path.join(home, "empty-bundled");
    const configPath = path.join(stateDir, "openclaw.json");
    const counts = path.join(home, "hooks.log");
    await Promise.all(
      [stateDir, workspaceDir, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const written = await Promise.all(
      plugins.map((plugin) => writePlugin(home, plugin.id, plugin.turnHandover, counts)),
    );
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const token = randomUUID();
    const failure = createDeferred<Error>();
    const delivered = createDeferred();
    const steps: Step[] = [];
    const startedAt = Date.now();
    let reloadStartedAt = 0;
    let reloadSettledAt = 0;
    let deliveredAt = 0;
    let reload: Promise<unknown> | undefined;
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
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const scenario = withEnvAsync(env, async () => {
      try {
        provider = await startOpenAiResponsesModelServer({
          modelId: "qa-turn-handover",
          bindError: "provider bind failed",
          onRequest: async (request, response) => {
            try {
              const body = JSON.parse(await readBody(request)) as Body;
              if (
                JSON.stringify(body.instructions ?? "").includes("Generate a concise session title")
              ) {
                writeOpenAiResponsesText(response, {
                  text: "Handover",
                  messageId: "t",
                  responseId: "t",
                });
                return;
              }
              const outputs = body.input.filter((item) => item.type === "function_call_output");
              for (const output of outputs.slice(steps.length)) {
                steps.push({
                  step: steps.length + 1,
                  atMs: Date.now() - startedAt,
                  ...(JSON.parse(output.output ?? "{}") as Pick<Step, "plugin" | "generation">),
                });
              }
              if (steps.length === RELOAD_AFTER_STEP && !reload) {
                reloadStartedAt = Date.now();
                reload = gateway!.client
                  .request("plugins.reload", {
                    plugins: written.map(({ id }) => ({ pluginId: id })),
                  })
                  .finally(() => {
                    reloadSettledAt = Date.now();
                  });
              }
              if (steps.length >= STEPS) {
                writeOpenAiResponsesText(response, {
                  text: FINAL_REPLY,
                  messageId: "f",
                  responseId: "f",
                });
                return;
              }
              // Alternate tools across plugins so every reloaded plugin is held by the turn.
              const tool = written[steps.length % written.length]!.tool;
              writeToolCall(response, tool, "s" + steps.length + "-" + outputs.length);
            } catch (error) {
              failure.resolve(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
          },
        });
        const cfg = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId: "qa-turn-handover",
          reasoning: false,
          toolProfile: "full",
        });
        cfg.agents!.defaults!.workspace = workspaceDir;
        cfg.agents!.defaults!.models = {
          "mock-openai/qa-turn-handover": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        };
        cfg.agents!.entries = { main: {} };
        cfg.plugins = {
          enabled: true,
          allow: written.map(({ id }) => id),
          load: { paths: written.map(({ root }) => root) },
          slots: { memory: "none" },
          // External plugins need explicit consent to observe agent_end.
          entries: Object.fromEntries(
            written.map(({ id }) => [
              id,
              { enabled: true, hooks: { allowConversationAccess: true } },
            ]),
          ),
        };
        cfg.tools = { allow: written.map(({ tool }) => tool), codeMode: false, toolSearch: false };
        cfg.gateway = { auth: { mode: "token", token } };
        await fs.writeFile(configPath, JSON.stringify(cfg));
        await seedInstalledPluginIndex(
          Object.fromEntries(
            written.map(({ id, root }) => [
              id,
              { source: "path", sourcePath: root, installPath: root },
            ]),
          ),
          { env: process.env, config: cfg },
        );
        for (const { id, root } of written) {
          await resolvePluginCapabilityConsent({
            config: cfg,
            pluginId: id,
            env: process.env,
            acknowledge: {
              reviewToken: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(root, process.env, { config: cfg }),
              ),
            },
          });
        }
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
              JSON.stringify(event.payload).includes(FINAL_REPLY) &&
              (event.payload as { state?: string })?.state === "final"
            ) {
              deliveredAt = Date.now();
              delivered.resolve();
            }
          },
        });
        await gateway.server.startupSettled;
        const runtime = getRuntimeConfigSnapshot();
        assert(runtime);
        withFastReplyConfig(runtime);
        await gateway.client.request("chat.send", {
          sessionKey,
          message: "Run every handover step.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await withinTest(
          Promise.race([
            delivered.promise,
            failure.promise.then((error) => {
              throw error;
            }),
          ]),
          signal,
        );
        assert(reload, "the turn never reached the reload step");
        await reload;
        // agent_end side effects settle after the reply; wait for every plugin, then for strays.
        const agentEnds = async () =>
          (await fs.readFile(counts, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
        for (
          let waited = 0;
          (await agentEnds()) < written.length && waited < 15_000;
          waited += 100
        ) {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        });
        const summary = {
          turnMs: deliveredAt - startedAt,
          reloadMs: reloadSettledAt - reloadStartedAt,
          reloadSettledBeforeReply: reloadSettledAt < deliveredAt,
          steps: steps.map(({ plugin, generation, atMs }) => `${plugin}@${generation}+${atMs}ms`),
          agentEnds: await agentEnds(),
        };
        const proof = "turn-handover proof " + JSON.stringify(summary);
        console.log(proof);
        if (process.env.OPENCLAW_E2E_PROOF_OUT) {
          await fs.appendFile(process.env.OPENCLAW_E2E_PROOF_OUT, `${name} ${proof}\n`);
        }

        // One logical turn: every step ran exactly once, and agent_end fired once per plugin.
        expect(steps, proof).toHaveLength(STEPS);
        expect(summary.agentEnds, proof).toBe(written.length);
        const firstGeneration = new Map<string, number>();
        for (const { plugin, generation } of steps.slice(0, RELOAD_AFTER_STEP)) {
          firstGeneration.set(plugin, firstGeneration.get(plugin) ?? generation);
        }
        const later = steps.slice(RELOAD_AFTER_STEP + 1);
        if (handsOver) {
          // The reload finished mid-turn and later steps ran on the new generation.
          expect(summary.reloadSettledBeforeReply, proof).toBe(true);
          expect(
            later.every(
              ({ plugin, generation }) => generation > (firstGeneration.get(plugin) ?? 0),
            ),
            proof,
          ).toBe(true);
        } else {
          // The reload waited for the whole turn, which stayed on its first generation.
          expect(summary.reloadSettledBeforeReply, proof).toBe(false);
          expect(
            later.every(({ plugin, generation }) => generation === firstGeneration.get(plugin)),
            proof,
          ).toBe(true);
        }
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "Isolated turn handover proof complete" });
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
