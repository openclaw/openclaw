import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../src/config/io.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/plugin-sdk/sqlite-runtime-testing.js";
import { seedInstalledPluginIndex } from "../src/plugins/test-helpers/installed-plugin-index.js";
import { VERSION } from "../src/version.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "codex";
const SESSION_KEY = "agent:main:copied-codex-session";
const VISIBLE_REPLY = "COPIED_CODEX_SESSION_RESUMED";
const TEST_TIMEOUT_MS = 120_000;
const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => await instance.cleanup()));
  closeOpenClawAgentDatabasesForTest();
});

function buildCopiedStateConfig(enabled: boolean | undefined): OpenClawConfig {
  const { config: provider } = buildMockOpenAiResponsesProvider(
    "https://example.invalid/v1",
    "proof-model",
  );
  delete provider.apiKey;
  return {
    plugins: {
      enabled: true,
      entries: enabled === undefined ? {} : { codex: { enabled } },
      slots: { memory: "none" },
    },
    models: {
      providers: {
        "copied-session-proof": provider,
      },
    },
    agents: { defaults: { model: { primary: "copied-session-proof/proof-model" } } },
  };
}

async function installCodexHarnessFixture(stateDir: string, config: OpenClawConfig): Promise<void> {
  const pluginDir = path.join(stateDir, "extensions", PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  const writeMetadata = (name: string, value: unknown) =>
    fs.writeFile(path.join(pluginDir, name), JSON.stringify(value));
  await writeMetadata("openclaw.plugin.json", {
    id: PLUGIN_ID,
    name: "Copied Codex session proof",
    activation: { onStartup: false, onAgentHarnesses: [PLUGIN_ID] },
    configSchema: { type: "object", additionalProperties: false },
  });
  await writeMetadata("package.json", {
    name: "@openclaw/codex",
    version: VERSION,
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `import { createAgentHarnessAssistantMessage } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
export default {
      id: "codex",
      register(api) {
        api.registerAgentHarness({
          id: "codex",
          label: "Copied Codex session proof",
          authBootstrap: "harness",
          supports: () => ({ supported: true, priority: 100 }),
          async runAttempt() {
            const text = ${JSON.stringify(VISIBLE_REPLY)};
            const assistant = createAgentHarnessAssistantMessage(
              { api: "openai-responses", provider: "copied-session-proof", modelId: "proof-model" },
              text, { aborted: false },
            );
            return {
              terminal: { kind: "ok" },
              sessionIdUsed: "copied-codex-thread",
              messagesSnapshot: [assistant],
              assistantTexts: [text],
              toolMetas: [],
              lastAssistant: assistant,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentMediaUrls: [],
              messagingToolSentTargets: [],
              cloudCodeAssistFormatError: false,
              replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
              itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
            };
          },
        });
      },
    };\n`,
  );
  await seedInstalledPluginIndex(
    {
      [PLUGIN_ID]: {
        source: "path",
        sourcePath: pluginDir,
        installPath: pluginDir,
      },
    },
    {
      stateDir,
      config,
      candidates: [
        {
          idHint: PLUGIN_ID,
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "global",
        },
      ],
    },
  );
}

it.each([
  ["resumes a trusted copied harness", true, undefined, false],
  ["rejects a disabled copied harness", false, "owner-plugin-not-activatable", false],
  ["rejects an untrusted copied harness", undefined, "owner-plugin-degraded", false],
  ["selects a lazy cron harness with agent overrides", true, undefined, true],
] as const)(
  "%s",
  async (_name, enabled, unavailableReason, cron) => {
    const config = buildCopiedStateConfig(enabled);
    if (cron) {
      const agents = config.agents!;
      const provider = config.models!.providers!["copied-session-proof"]!;
      agents.entries = {
        main: {
          model: {
            primary: "copied-session-proof/alternate-model",
            fallbacks: ["copied-session-proof/proof-model"],
          },
        },
      };
      agents.defaults!.models = {
        "copied-session-proof/cron-model": { agentRuntime: { id: "codex" } },
      };
      for (const id of ["alternate-model", "cron-model"]) {
        provider.models.push({
          ...provider.models[0]!,
          id,
          name: id,
        });
      }
    }
    const instance = await createOpenClawTestInstance({
      name: "copied-codex-session-resume",
      config,
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        ...(cron ? { OPENCLAW_SKIP_CRON: undefined } : {}),
      },
    });
    instances.push(instance);
    await installCodexHarnessFixture(instance.stateDir, config);

    instance.state.applyEnv();
    await captureRuntimeConfigAsyncReader()();
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      entry: {
        sessionId: "copied-codex-thread",
        updatedAt: Date.now(),
        modelProvider: "copied-session-proof",
        model: "proof-model",
        modelSelectionLocked: true,
        agentHarnessId: "codex",
      },
    });
    closeOpenClawAgentDatabasesForTest();

    await instance.startGateway();
    const client = await connectProofClient(instance, { requestTimeoutMs: 30_000 });
    try {
      if (cron) {
        const job = await client.request<{ id: string }>("cron.add", {
          name: "Copied session cron runtime",
          agentId: "main",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: "Resume this copied conversation from cron.",
            model: "copied-session-proof/cron-model",
          },
          delivery: { mode: "none" },
        });
        try {
          await client.request("cron.run", { id: job.id, mode: "force" });
          await expect
            .poll(() => client.request("cron.runs", { id: job.id, limit: 1 }), {
              timeout: 30_000,
              interval: 100,
            })
            .toMatchObject({ entries: [{ status: "ok", summary: VISIBLE_REPLY }] });
        } finally {
          await client.request("cron.remove", { id: job.id });
        }
        return;
      }
      const request = client.request(
        "agent",
        {
          sessionKey: SESSION_KEY,
          idempotencyKey: "copied-codex-session-resume",
          message: "Resume this copied conversation.",
          deliver: false,
          timeout: 30,
        },
        { expectFinal: true, timeoutMs: 30_000 },
      );

      if (enabled !== true) {
        await expect(request).rejects.toThrow(
          `Agent harness runtime "codex" is unavailable. (reason=${unavailableReason}, ownerPluginId=codex)`,
        );
        await expect(request).rejects.toThrow('Run "openclaw doctor --fix"');
        return;
      }
      expect(await request).toMatchObject({
        status: "ok",
        result: { payloads: [{ text: VISIBLE_REPLY }] },
      });
    } finally {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
  },
  TEST_TIMEOUT_MS,
);
