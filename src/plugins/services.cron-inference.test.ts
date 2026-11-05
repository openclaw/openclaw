import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { createAuthOwnerTestFixtures } from "../agents/auth-profiles/store-state-owner.test-support.js";
import { CronService } from "../cron/service.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createRegistry,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.test-support.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "plugin-service-cron-inference-" });
const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
const storedProfileId = "openai:platform";
const handles = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
  for (const cron of schedulers) {
    cron.stop();
  }
  schedulers.clear();
});

function capturingRegistry(pluginId: string) {
  let context: OpenClawPluginServiceContext | undefined;
  const registry = createRegistry(
    [
      {
        id: "maintenance",
        start: (started) => {
          context = started;
        },
      },
    ],
    pluginId,
  );
  return { registry, getContext: () => expectDefined(context, "started service context") };
}

function storedAccountConfig(agentDir: string) {
  return {
    agents: { entries: { main: { agentDir } }, defaults: { model: "openai/gpt-4.1" } },
    auth: {
      profiles: { [storedProfileId]: { provider: "openai", mode: "api_key" as const } },
      order: { openai: [storedProfileId] },
    },
  };
}

it("records the inference account for a service-created agent turn", async () => {
  const seeded = await seedRoot("synthetic-unrelated-root-key");
  const root = { ...seeded, agentDir: path.join(seeded.stateDir, "agents", "main", "agent") };
  await withEnvAsync(
    {
      ...root.env,
      OPENCLAW_CONFIG_PATH: path.join(root.stateDir, "absent-config.json"),
      OPENAI_API_KEY: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
    },
    async () => {
      await persistAuthProfileBatch({
        profiles: [{ profileId: storedProfileId, credential: apiKey("synthetic-platform-key") }],
      });
      await runServiceCreation(root.agentDir);
    },
  );
});

async function runServiceCreation(agentDir: string) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const }),
  });
  schedulers.add(cron);

  const { registry, getContext } = capturingRegistry("test-plugin");
  const handle = await startPluginServices({
    registry,
    config: storedAccountConfig(agentDir),
    getCronService: () => cron,
  });
  handles.add(handle);

  const service = expectDefined(getContext().getCron?.(), "Gateway scheduler");
  // Before this change the service handle forwarded no inferenceBinding, so the stored job
  // had no recorded account and stored-profile runs were refused before the model.
  await service.add({
    declarationKey: "test-plugin:maintenance",
    name: "Plugin maintenance",
    enabled: false,
    schedule: { kind: "cron", expr: "0 2 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "maintenance" },
  });

  const [job] = await service.list({ includeDisabled: true });
  expect(expectDefined(job, "created plugin job").inferenceBinding).toMatchObject({
    version: 1,
    provider: "openai",
    profileId: storedProfileId,
  });
}
