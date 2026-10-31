import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import type { CronJob as CronJobView } from "../packages/gateway-protocol/src/schema/cron.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "../src/gateway/test-helpers.listener.js";
import type { PluginSessionSchedulerJobHandle as ScheduledHandle } from "../src/plugins/host-hooks.js";
import type { TestPortClaim } from "../src/test-utils/port-claims.js";
import { writeRestartPlugin } from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
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

type MockModelRequest = { body: Record<string, unknown> };

type MockModelServer = Awaited<ReturnType<typeof startMockModelServer>>;

type ScheduleResult = { handle: ScheduledHandle | null };

const instances: OpenClawTestInstance[] = [];
const portClaims: TestPortClaim[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(portClaims.splice(0).map((claim) => claim.release()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startMockModelServer() {
  const requests: MockModelRequest[] = [];
  const server = await startOpenAiResponsesModelServer({
    modelId: "cron-owner",
    bindError: "mock model server did not bind",
    onRequest: async (req, res) => {
      const body = (await json(req)) as Record<string, unknown>;
      requests.push({ body });
      writeOpenAiResponsesText(res, {
        messageId: `msg_cron_owner_${requests.length}`,
        responseId: `resp_cron_owner_${requests.length}`,
        text: `CRON_OWNER_RESPONSE_${requests.length}`,
      });
    },
  });
  return { baseUrl: server.baseUrl, requests, stop: server.close };
}

async function writeBundledSchedulerPlugin(bundledRoot: string): Promise<void> {
  await writeRestartPlugin(
    path.join(bundledRoot, PLUGIN_ID),
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
      const { name, message, sessionKey } = params;
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
    "index.js",
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

function expectMainWorkspace(requests: MockModelRequest[]) {
  for (const request of requests) {
    expect(requestText(request)).toContain(MAIN_WORKSPACE_MARKER);
    expect(requestText(request)).not.toContain(WORKER_WORKSPACE_MARKER);
  }
}

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
      models: createOpenAiResponsesModelConfig({
        baseUrl: modelServer.baseUrl,
        providerId: "cron-owner",
        modelId: "cron-owner",
        reasoning: false,
        toolProfile: "minimal",
      }).models,
    } satisfies OpenClawConfig;
    const claim = await acquireGatewayE2ePortBlock();
    portClaims.push(claim);
    const instance = await createOpenClawTestInstance({
      name: "plugin-cron-registry-owner",
      port: claim.port,
      config,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);
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
