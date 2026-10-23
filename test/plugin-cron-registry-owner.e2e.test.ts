import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import type { CronJob as CronJobView } from "../packages/gateway-protocol/src/schema/cron.types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "../src/gateway/test-helpers.listener.js";
import { upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/plugin-sdk/sqlite-runtime-testing.js";
import type { PluginSessionSchedulerJobHandle as ScheduledHandle } from "../src/plugins/host-hooks.js";
import type { TestPortClaim } from "../src/test-utils/port-claims.js";
import { startOpenAiResponsesModelServer } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "cron-registry-owner-proof";
const SCHEDULE_METHOD = `${PLUGIN_ID}.schedule`;
const CRON_EXPRESSION = "*/2 * * * * *";
const MAIN_WORKSPACE_MARKER = "MAIN_WORKSPACE_CRON_OWNER_MARKER";
const WORKER_WORKSPACE_MARKER = "WORKER_WORKSPACE_CRON_OWNER_MARKER";
const OWNER_FIRE = "CRON_OWNER_SURVIVAL_FIRE";
const PINNED_FIRE = "CRON_PINNED_LATE_FIRE";
const E2E_TIMEOUT_MS = 180_000;
const WAIT_OPTIONS = { timeout: 45_000, interval: 50 } as const;
const TEST_API_KEY = "test-token-placeholder";

type MockModelRequest = { body: Record<string, unknown> };

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  stop: () => Promise<void>;
};

type ScheduleResult = { handle: ScheduledHandle | null };
type CronTerminal = { status?: string; summary?: string; error?: string };

const instances: OpenClawTestInstance[] = [];
const portClaims: TestPortClaim[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(portClaims.splice(0).map((claim) => claim.release()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearRuntimeConfigSnapshot();
});

async function startMockModelServer(rejectModel?: string): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const server = await startOpenAiResponsesModelServer({
    modelId: "cron-owner",
    bindError: "mock model server did not bind",
    onRequest: async (req, res) => {
      const body = (await json(req)) as Record<string, unknown>;
      requests.push({ body });
      if (rejectModel && body.model === rejectModel) {
        // Missing models advance fallback; transient outages first recover on the same model.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "model_not_found", message: "Model not found" } }));
        return;
      }
      writeOpenAiResponsesText(res, {
        messageId: `msg_cron_owner_${requests.length}`,
        responseId: `resp_cron_owner_${requests.length}`,
        text: `CRON_OWNER_RESPONSE_${requests.length}`,
      });
    },
  });
  return { baseUrl: server.baseUrl, requests, stop: server.close };
}

type FixtureManifest = Record<string, unknown> & { id: string };
async function writePlugin(root: string, manifest: FixtureManifest, source: string) {
  const pluginDir = path.join(root, manifest.id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(pluginDir, "index.js"), source);
}

async function writeBundledSchedulerPlugin(bundledRoot: string): Promise<void> {
  await writePlugin(
    bundledRoot,
    {
      id: PLUGIN_ID,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    const scheduleSessionTurn = api.session.workflow.scheduleSessionTurn;
    const cronReady = new Promise((resolve) => {
      api.on("cron_reconciled", () => resolve());
    });
    api.registerGatewayMethod(${JSON.stringify(SCHEDULE_METHOD)}, async ({ params, respond }) => {
      await cronReady;
      const name = typeof params?.name === "string" ? params.name : "";
      const message = typeof params?.message === "string" ? params.message : "";
      const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
      const handle = await scheduleSessionTurn({
        sessionKey,
        message,
        cron: ${JSON.stringify(CRON_EXPRESSION)},
        tz: "UTC",
        deliveryMode: "none",
        tag: "registry-owner",
        name,
      });
      respond(true, { handle: handle ?? null });
    });
  },
};
`,
  );
}

const requestText = (request: MockModelRequest) => JSON.stringify(request.body);

function requestsContaining(server: MockModelServer, marker: string): MockModelRequest[] {
  return server.requests.filter((request) => requestText(request).includes(marker));
}

async function waitForRequestCount(
  server: MockModelServer,
  marker: string,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      requestsContaining(server, marker).length,
      `model request marker: ${marker}`,
    ).toBeGreaterThanOrEqual(count);
  }, WAIT_OPTIONS);
}

function requireHandle(result: ScheduleResult, expected: Omit<ScheduledHandle, "id">): string {
  expect(result.handle).toMatchObject(expected);
  if (!result.handle) {
    throw new Error(`missing scheduled handle for ${expected.sessionKey}`);
  }
  expect(result.handle.id).toBeTruthy();
  return result.handle.id;
}

async function listCronJobs(client: {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
}): Promise<CronJobView[]> {
  const page = await client.request<{ jobs: CronJobView[] }>("cron.list", {
    includeDisabled: true,
    scheduleKind: "cron",
    limit: 200,
  });
  return page.jobs;
}

function model(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function providerConfig(server: MockModelServer, ids: string[], auth: boolean) {
  return {
    baseUrl: `${server.baseUrl}/v1`,
    api: "openai-responses" as const,
    auth: auth ? ("api-key" as const) : undefined,
    apiKey: auth ? TEST_API_KEY : undefined,
    request: { allowPrivateNetwork: true },
    models: ids.map(model),
  };
}

async function createInstance(name: string, root: string, config: OpenClawConfig, port?: number) {
  const instance = await createOpenClawTestInstance({
    name,
    port,
    config,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: root,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_CRON: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  instances.push(instance);
  return instance;
}

function expectMainWorkspace(requests: MockModelRequest[]) {
  for (const request of requests) {
    expect(requestText(request)).toContain(MAIN_WORKSPACE_MARKER);
    expect(requestText(request)).not.toContain(WORKER_WORKSPACE_MARKER);
  }
}

it.each(["cron", "subagent"] as const)(
  "prepares distinct selected and fallback providers for %s under per-agent defaults",
  async (route) => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-cron-selection-e2e-"));
    cleanupDirs.push(fixtureDir);
    const bundledRoot = path.join(fixtureDir, "bundled");
    const provider = "selected-cron";
    const fallbackProvider = "selected-fallback";
    const pluginIds = [provider, fallbackProvider];
    for (const pluginId of pluginIds) {
      await writePlugin(
        bundledRoot,
        {
          id: pluginId,
          providers: [pluginId],
          activation: { onStartup: false, onProviders: [pluginId] },
          configSchema: { type: "object", additionalProperties: false },
        },
        `module.exports = {
        id: ${JSON.stringify(pluginId)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(pluginId)}, label: "Selected provider", auth: [],
            resolveSyntheticAuth: () => ({ apiKey: "cron-fixture", source: "fixture", mode: "api-key" }),
            transformSystemPrompt: ({ systemPrompt }) => systemPrompt + "\\n" + ${JSON.stringify(`PROVIDER_HOOK_${pluginId}`)},
          });
        },
      };\n`,
      );
    }
    const server = await startMockModelServer("unavailable");
    modelServers.push(server);
    const fallbackModel = {
      primary: `${provider}/unavailable`,
      fallbacks: [`${fallbackProvider}/available`],
    };
    const config: OpenClawConfig = {
      plugins: {
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
        slots: { memory: "none" },
      },
      agents: {
        defaults: {
          workspace: path.join(fixtureDir, "workspace"),
          model: { primary: "cron-owner/default" },
          skills: [],
          subagents: route === "subagent" ? { model: fallbackModel } : undefined,
        },
        entries: { main: { model: { primary: "cron-owner/agent-default" } } },
      },
      tools: { profile: "minimal" },
      models: {
        mode: "replace",
        providers: {
          "cron-owner": {
            ...providerConfig(server, ["default", "agent-default"], false),
            apiKey: TEST_API_KEY,
          },
          // Cron admission needs explicit key auth before the provider runtime loads.
          [provider]: providerConfig(server, ["unavailable"], route === "cron"),
          [fallbackProvider]: providerConfig(server, ["available"], route === "cron"),
        },
      },
    };
    const instance = await createInstance("cron-selected-provider", bundledRoot, config);
    const sessionKey = "agent:main:subagent:provider-fallback";
    if (route === "subagent") {
      instance.state.applyEnv();
      setRuntimeConfigSnapshot(config);
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        entry: {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          providerOverride: provider,
          modelOverride: "unavailable",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: provider,
          modelOverrideFallbackOriginModel: "unavailable",
        },
      });
      closeOpenClawAgentDatabasesForTest();
    }
    await instance.startGateway();
    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
    });
    let jobId: string | undefined;
    try {
      if (route === "subagent") {
        expect(
          await client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: randomUUID(),
              message: "Prove the selected provider runtime.",
              deliver: false,
              timeout: 45,
            },
            { expectFinal: true, timeoutMs: 45_000 },
          ),
        ).toMatchObject({
          status: "ok",
          result: { payloads: [{ text: expect.stringContaining("CRON_OWNER_RESPONSE_") }] },
        });
      } else {
        const job = await client.request<{ id: string }>("cron.add", {
          name: "Selected provider fallback",
          agentId: "main",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          delivery: { mode: "none" },
          payload: {
            kind: "agentTurn",
            message: "Prove the selected provider runtime.",
            model: fallbackModel.primary,
            fallbacks: fallbackModel.fallbacks,
          },
        });
        jobId = job.id;
        const run = await client.request<{ runId: string }>("cron.run", {
          id: jobId,
          mode: "force",
        });
        let terminal: CronTerminal | undefined;
        await expect
          .poll(async () => {
            const history = await client.request<{ entries: CronTerminal[] }>("cron.runs", {
              id: jobId,
              runId: run.runId,
              limit: 1,
            });
            terminal = history.entries[0];
            return terminal?.status;
          }, WAIT_OPTIONS)
          .toBeDefined();
        expect(terminal?.error).toBeUndefined();
        expect(terminal).toMatchObject({
          status: "ok",
          summary: expect.stringContaining("CRON_OWNER_RESPONSE_"),
        });
      }
      const models = server.requests.map(({ body }) => body.model);
      expect(models).toContain("unavailable");
      expect(models.at(-1)).toBe("available");
      expect(requestText(server.requests[0]!)).toContain(`PROVIDER_HOOK_${provider}`);
      expect(requestText(server.requests.at(-1)!)).toContain(`PROVIDER_HOOK_${fallbackProvider}`);
    } finally {
      if (jobId) {
        await client.request("cron.remove", { id: jobId });
      }
      await disconnectGatewayClient(client);
    }
  },
  E2E_TIMEOUT_MS,
);

it(
  "keeps recurring startup-plugin jobs through workspace registry churn",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-cron-owner-e2e-"));
    cleanupDirs.push(fixtureDir);
    const bundledRoot = path.join(fixtureDir, "bundled");
    const mainWorkspace = path.join(fixtureDir, "workspace-main");
    const workerWorkspace = path.join(fixtureDir, "workspace-worker");
    await Promise.all([
      mkdir(mainWorkspace, { recursive: true }),
      mkdir(workerWorkspace, { recursive: true }),
      writeBundledSchedulerPlugin(bundledRoot),
    ]);
    await Promise.all([
      writeFile(path.join(mainWorkspace, "AGENTS.md"), `${MAIN_WORKSPACE_MARKER}\n`),
      writeFile(path.join(workerWorkspace, "AGENTS.md"), `${WORKER_WORKSPACE_MARKER}\n`),
    ]);

    const modelServer = await startMockModelServer();
    modelServers.push(modelServer);
    const modelRef = "cron-owner/cron-owner";
    const agentConfig = (workspace: string) => ({
      workspace,
      model: { primary: modelRef },
      skills: [],
    });
    const config = {
      plugins: {
        enabled: true,
        allow: [PLUGIN_ID],
        entries: { [PLUGIN_ID]: { enabled: true } },
        slots: { memory: "none" },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          ...agentConfig(mainWorkspace),
          systemAgent: { agentId: "main" },
          modelPolicy: { allow: [modelRef] },
          models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: agentConfig(mainWorkspace), worker: agentConfig(workerWorkspace) },
      },
      tools: { profile: "minimal" },
      models: {
        mode: "replace",
        providers: {
          "cron-owner": {
            ...providerConfig(modelServer, [], false),
            apiKey: TEST_API_KEY,
            models: [{ ...model("cron-owner"), api: "openai-responses" }],
          },
        },
      },
    } satisfies OpenClawConfig;
    const claim = await acquireGatewayE2ePortBlock();
    portClaims.push(claim);
    const instance = await createInstance(
      "plugin-cron-registry-owner",
      bundledRoot,
      config,
      claim.port,
    );
    await instance.startGateway();
    expect(instance.port).toBe(claim.port);

    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      requestTimeoutMs: 30_000,
    });
    const scheduledIds: string[] = [];
    const schedule = async (name: string, message: string) => {
      const sessionKey = `agent:main:cron-${name}`;
      const params = { name, message, sessionKey };
      const result = await client.request<ScheduleResult>(SCHEDULE_METHOD, params);
      const id = requireHandle(result, { pluginId: PLUGIN_ID, sessionKey, kind: "session-turn" });
      scheduledIds.push(id);
      return id;
    };
    const activate = async (agent: string, message: string) => {
      const count = requestsContaining(modelServer, message).length;
      await client.request("chat.send", {
        sessionKey: `agent:${agent}:registry-churn`,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      await waitForRequestCount(modelServer, message, count + 1);
    };
    const expectRecurringRuns = async (count: number) => {
      const baselines = [OWNER_FIRE, PINNED_FIRE].map(
        (marker) => [marker, requestsContaining(modelServer, marker).length] as const,
      );
      await Promise.all(
        baselines.map(([marker, baseline]) =>
          waitForRequestCount(modelServer, marker, baseline + count),
        ),
      );
      expectMainWorkspace(
        baselines.flatMap(([marker, baseline]) =>
          requestsContaining(modelServer, marker).slice(baseline),
        ),
      );
    };
    try {
      expect(await client.request("cron.status", {})).toMatchObject({
        enabled: true,
        storage: "sqlite",
        sqlitePath: path.join(instance.stateDir, "state", "openclaw.sqlite"),
      });

      const ownerId = await schedule("owner-survival", OWNER_FIRE);
      await activate("worker", "ACTIVATE_WORKER_REGISTRY");

      // The attached Gateway handler still closes over the pinned startup registry API.
      // Scheduling here proves non-active pinned registries remain live during workspace churn.
      const pinnedId = await schedule("pinned-late", PINNED_FIRE);
      await expectRecurringRuns(1);
      await activate("main", "REACTIVATE_MAIN_REGISTRY");

      const expectedIds = [ownerId, pinnedId].toSorted();
      const afterChurn = (await listCronJobs(client))
        .filter((job) => expectedIds.includes(job.id))
        .toSorted((a, b) => a.id.localeCompare(b.id));
      expect(afterChurn.map((job) => job.id)).toEqual(expectedIds);
      const expectedJob = (id: string, session: string) =>
        expect.objectContaining({
          id,
          enabled: true,
          deleteAfterRun: false,
          sessionTarget: `session:agent:main:${session}`,
          schedule: { kind: "cron", expr: CRON_EXPRESSION, tz: "UTC" },
        });
      expect(afterChurn).toEqual(
        expect.arrayContaining([
          expectedJob(ownerId, "cron-owner-survival"),
          expectedJob(pinnedId, "cron-pinned-late"),
        ]),
      );
      const nextRunAtChurn = new Map(afterChurn.map((job) => [job.id, job.state.nextRunAtMs]));
      expect([...nextRunAtChurn.values()]).toEqual([expect.any(Number), expect.any(Number)]);

      await expectRecurringRuns(2);

      const afterRecurringRuns = (await listCronJobs(client)).filter((job) =>
        expectedIds.includes(job.id),
      );
      expect(afterRecurringRuns.map((job) => job.id).toSorted()).toEqual(expectedIds);
      for (const job of afterRecurringRuns) {
        expect(job).toMatchObject({ enabled: true, deleteAfterRun: false });
        expect(job.state.lastRunStatus ?? job.state.lastStatus).toBe("ok");
        const lastRunAtMs = job.state.lastRunAtMs;
        const nextRunAtMs = job.state.nextRunAtMs;
        expect(lastRunAtMs).toBeTypeOf("number");
        expect(nextRunAtMs).toBeTypeOf("number");
        expect(nextRunAtMs as number).toBeGreaterThan(lastRunAtMs as number);
        expect(nextRunAtMs as number).toBeGreaterThan(nextRunAtChurn.get(job.id) as number);
      }
    } finally {
      await Promise.all(
        scheduledIds.map((id) =>
          client.request("cron.remove", { id }).catch(() => ({ removed: false })),
        ),
      );
      await disconnectGatewayClient(client).catch(() => undefined);
    }
  },
);
