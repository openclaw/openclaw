// Load the Gateway's deferred runtime during collection, outside the RPC deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, assert, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import type { MockInstance } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { localStateOwnerFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  getRuntimeConfig,
  readConfigFileSnapshot,
  registerConfigWriteListener,
} from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import * as configReload from "./config-reload.js";
import * as agentDatabases from "./server-reload-agent-databases.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

const cliEntrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

const agentId = "readiness-agent";
const publicationEntered = createDeferred();
const releasePublication = createDeferred();
const creationBookkeepingCompleted = createDeferred();
let publicationHeld = false;
let reloadScheduler: GatewayScheduler | undefined;
const token = "agent-config-readiness-token";
const recoveryRestart = vi.fn(() => {
  throw new Error("Agent mutations must hot-apply without a recovery restart");
});
let state: OpenClawTestState;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;
let owner: Awaited<ReturnType<typeof acquireGatewayLock>>;
let server: Awaited<ReturnType<typeof startGatewayServer>>;
let client: Awaited<ReturnType<typeof connectGatewayClient>>;
let reloaderSpy: MockInstance<typeof configReload.startGatewayConfigReloader> | undefined;
let revivalSpy:
  | MockInstance<typeof agentDatabases.reviveAgentDatabasesAfterConfigCommit>
  | undefined;
const connect = () =>
  connectGatewayClient({
    url: `ws://127.0.0.1:${claim.port}`,
    token,
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
const rpc = (method: string, params: Record<string, unknown>) => client.request(method, params);
const matches = async (result: Promise<unknown>, expected: object) =>
  expect(await result).toMatchObject(expected);
const roster = (entry: Record<string, unknown>) => ({
  agents: expect.arrayContaining([expect.objectContaining(entry)]),
});
const expectSavedOnly = async (id: string) => {
  expect((await readConfigFileSnapshot()).sourceConfig.agents?.entries?.[id]).toBeDefined();
  expect(getRuntimeConfig().agents?.entries?.[id]).toBeUndefined();
};

beforeAll(async () => {
  const startReloader = configReload.startGatewayConfigReloader;
  reloaderSpy = vi
    .spyOn(configReload, "startGatewayConfigReloader")
    .mockImplementation((options) => {
      reloadScheduler = options.scheduler;
      return startReloader({
        ...options,
        onHotReload: async (...args) => {
          if (!publicationHeld && args[1].agents?.entries?.[agentId]) {
            publicationHeld = true;
            publicationEntered.resolve();
            await releasePublication.promise;
          }
          return options.onHotReload(...args);
        },
      });
    });
  const reviveDatabases = agentDatabases.reviveAgentDatabasesAfterConfigCommit;
  revivalSpy = vi
    .spyOn(agentDatabases, "reviveAgentDatabasesAfterConfigCommit")
    .mockImplementation(async (...args) => {
      await reviveDatabases(...args);
      if (args[0].length === 1 && args[0][0] === agentId) {
        creationBookkeepingCompleted.resolve();
      }
    });
  state = await createOpenClawTestState({
    label: "agent-config-readiness",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  await state.writeConfig({
    gateway: { mode: "local", auth: { mode: "token", token } },
    agents: {
      ownership: "explicit",
      defaults: { skipBootstrap: true, model: "openai/gpt-4.1", heartbeat: { every: "0m" } },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { slots: { memory: "none" } },
  });
  claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  owner = await acquireGatewayLock({
    env: state.env,
    port: claim.port,
    allowInTests: true,
  });
  assert.isNotNull(owner);
  server = await startGatewayServer(claim.port, {
    gatewayStateOwner: owner,
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    hotReloadRecovery: recoveryRestart,
  });
  await server.startupSettled;
  client = await connect();
});

afterAll(async () => {
  const errors: unknown[] = [];
  const cleanups: Array<() => Promise<unknown> | void> = [
    () => releasePublication.resolve(),
    () => client && disconnectGatewayClient(client),
    () => server?.close(),
    () => owner?.release(),
    () => claim?.release(),
    () => state?.cleanup(),
    () => reloaderSpy?.mockRestore(),
    () => revivalSpy?.mockRestore(),
  ];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Agent config readiness teardown failed");
  }
});

it("publishes agent mutations before acknowledging immediate session and roster requests", async ({
  signal,
}) => {
  const key = `agent:${agentId}:first-session`;
  let creationAcknowledged = false;
  await expect(
    rpc("agents.create", {
      name: "Retired Owner",
      workspace: path.join(state.home, "workspace-retired"),
      expectedOwnerId: "retired-owner",
    }),
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
  });
  await expect(fs.stat(path.join(state.home, "workspace-retired"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const creation = runCliProcessChild({
    nodeArgs: [
      ...cliEntrypoint,
      "agents",
      "add",
      "Readiness Agent",
      "--non-interactive",
      "--json",
      "--workspace",
      path.join(state.home, "workspace-readiness"),
      "--model",
      "openai/gpt-5.6-sol",
    ],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...state.envVars,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  }).then((result) => {
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  });
  onTestFinished(async () => {
    releasePublication.resolve();
    await Promise.allSettled([creation]);
  });
  const firstSession = creation.then(() => {
    creationAcknowledged = true;
    return rpc("sessions.create", { agentId, key });
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([publicationEntered.promise, creationBookkeepingCompleted.promise]),
        firstSession,
        "Creation finished before reaching the held config publication",
      ),
      signal,
    );
    // Finish a wire read after creation bookkeeping, while publication remains held.
    await expect(rpc("agents.list", {})).resolves.toMatchObject({
      agents: expect.not.arrayContaining([expect.objectContaining({ id: agentId })]),
    });
    if (creationAcknowledged) {
      await withinTest(firstSession, signal);
    }
    expect(creationAcknowledged, "agents.create acknowledged before runtime publication").toBe(
      false,
    );
  } finally {
    releasePublication.resolve();
  }
  await matches(creation, { agentId });
  await matches(rpc("agents.list", {}), roster({ id: agentId }));
  expect(await withinTest(firstSession, signal)).toMatchObject({ key });
  await matches(rpc("sessions.list", { agentId }), {
    sessions: expect.arrayContaining([expect.objectContaining({ key })]),
  });

  await matches(
    rpc("agents.update", {
      agentId,
      name: "Ready Immediately",
      model: "openai/gpt-4.1",
    }),
    { ok: true, agentId },
  );
  await matches(rpc("agents.list", {}), roster({ id: agentId, name: "Ready Immediately" }));
  expect(resolveAgentModelPrimaryValue(getRuntimeConfig().agents?.entries?.[agentId]?.model)).toBe(
    "openai/gpt-4.1",
  );
  await matches(rpc("sessions.create", { agentId, key: `agent:${agentId}:after-update` }), {
    key: `agent:${agentId}:after-update`,
  });

  await matches(rpc("agents.delete", { agentId, deleteFiles: false }), { ok: true, agentId });
  for (const incognito of [false, true]) {
    await expect(
      rpc("sessions.create", {
        agentId,
        key: `agent:${agentId}:after-delete`,
        incognito,
      }),
    ).rejects.toThrow(`Unknown agent id "${agentId}"`);
  }
  expect(getRuntimeConfig().agents?.entries?.[agentId]).toBeUndefined();
  expect(recoveryRestart).not.toHaveBeenCalled();
});

it("publishes overlapping mutations from two operators", async ({ signal }) => {
  const peer = await connect();
  try {
    await withinTest(
      Promise.all(
        [client, peer].map(async (operator, index) => {
          const otherOperator = index === 0 ? peer : client;
          for (let round = 0; round < 4; round += 1) {
            const overlapAgentId = `overlap-${index}-${round}`;
            await matches(
              operator.request("agents.create", {
                name: overlapAgentId,
                workspace: path.join(state.home, overlapAgentId),
              }),
              { agentId: overlapAgentId },
            );
            await matches(
              operator.request("sessions.create", {
                agentId: "main",
                key: `agent:main:${overlapAgentId}`,
              }),
              { key: `agent:main:${overlapAgentId}` },
            );
            const deletion = { agentId: overlapAgentId, deleteFiles: false };
            if (round === 0) {
              const results = await Promise.allSettled([
                operator.request("agents.delete", deletion),
                otherOperator.request("agents.delete", deletion),
              ]);
              expect(results.filter((result) => result.status === "fulfilled")).toEqual([
                {
                  status: "fulfilled",
                  value: expect.objectContaining({ ok: true, agentId: overlapAgentId }),
                },
              ]);
              const failure: unknown = results.find(
                (result) => result.status === "rejected",
              )?.reason;
              if (failure instanceof GatewayClientRequestError && failure.code === "UNAVAILABLE") {
                // Cleanup can outlast the concurrent loser's five-second lease wait.
                expect(failure.message).toContain(
                  `agent deletion core:agent-deletion/${overlapAgentId} is held by `,
                );
                expect(failure.message).toContain("code=OPENCLAW_STATE_LEASE_HELD");
              } else {
                expect(failure).toMatchObject({
                  code: "INVALID_REQUEST",
                  message: `agent "${overlapAgentId}" not found`,
                });
              }
            } else {
              await matches(operator.request("agents.delete", deletion), {
                ok: true,
                agentId: overlapAgentId,
              });
            }
            expect(getRuntimeConfig().agents?.entries?.[overlapAgentId]).toBeUndefined();
          }
        }),
      ),
      signal,
    );
  } finally {
    await disconnectGatewayClient(peer);
  }
  expect(recoveryRestart).not.toHaveBeenCalled();
});

it("reports unavailable publication and saved-only mutations", async ({ signal }) => {
  assert.isDefined(reloadScheduler);
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const schedule = reloadScheduler.schedule.bind(reloadScheduler);
  let written = createDeferred();
  let awaitingAgent = "";
  const unsubscribe = registerConfigWriteListener((event) => {
    if (event.sourceConfig.agents?.entries?.[awaitingAgent]) {
      written.resolve();
    }
  });
  const scheduleSpy = vi.spyOn(reloadScheduler, "schedule").mockImplementation((job) => {
    if (job.id !== "config:reload") {
      return schedule(job);
    }
    return scheduler.schedule(job);
  });
  try {
    for (const reason of ["storage-error", "lifecycle-busy"] as const) {
      written = createDeferred();
      const unavailableAgent = `unavailable-${reason}`;
      awaitingAgent = unavailableAgent;
      const failedCreation = client
        .request("agents.create", {
          name: unavailableAgent,
          workspace: path.join(state.home, unavailableAgent),
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await withinTest(written.promise, signal);
      const acquire = vi.spyOn(pluginLifecycleLease, "withPluginLifecycleLease").mockRejectedValue(
        new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
          kind: "store-unavailable",
          reason,
        }),
      );
      try {
        for (const delay of reason === "storage-error"
          ? [0]
          : [0, 250, 500, 1000, 2000, 4000, 5000]) {
          await clock.advanceBy(delay);
        }
        expect(acquire).toHaveBeenCalledTimes(reason === "storage-error" ? 1 : 7);
        expect(await withinTest(failedCreation, signal)).toMatchObject({
          error: { code: "UNAVAILABLE", message: expect.stringContaining("(failed)") },
        });
        await expectSavedOnly(unavailableAgent);
      } finally {
        acquire.mockRestore();
      }
    }
  } finally {
    unsubscribe();
    scheduleSpy.mockRestore();
    await scheduler.stop();
  }

  // Reload-off changes the shared Gateway config, so this case must remain last.
  const saved = (await readConfigFileSnapshot()).sourceConfig;
  await state.writeConfig({
    ...saved,
    gateway: { ...saved.gateway, reload: { mode: "off" } },
  });
  await expect(
    rpc("agents.create", {
      name: "Saved Only",
      workspace: path.join(state.home, "workspace-saved-only"),
    }),
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    message: expect.stringContaining("saved"),
  });
  await expectSavedOnly("saved-only");
  expect(recoveryRestart).not.toHaveBeenCalled();
});
