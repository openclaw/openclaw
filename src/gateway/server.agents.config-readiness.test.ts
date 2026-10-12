// Load the Gateway's deferred runtime during collection, outside the RPC deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import * as configReload from "./config-reload.js";
import * as agentDatabases from "./server-reload-agent-databases.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

const cliEntrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

it("publishes agent mutations before acknowledging immediate session and roster requests", async ({
  signal,
}) => {
  const agentId = "readiness-agent";
  const publicationEntered = createDeferred();
  const releasePublication = createDeferred();
  const creationBookkeepingCompleted = createDeferred();
  let publicationHeld = false;
  let reloadScheduler: GatewayScheduler | undefined;
  const startReloader = configReload.startGatewayConfigReloader;
  const reloaderSpy = vi
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
  const revivalSpy = vi
    .spyOn(agentDatabases, "reviveAgentDatabasesAfterConfigCommit")
    .mockImplementation(async (...args) => {
      await reviveDatabases(...args);
      if (args[0].length === 1 && args[0][0] === agentId) {
        creationBookkeepingCompleted.resolve();
      }
    });
  onTestFinished(() => {
    releasePublication.resolve();
    reloaderSpy.mockRestore();
    revivalSpy.mockRestore();
  });
  await withOpenClawTestState(
    {
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
    },
    async (state) => {
      const token = "agent-config-readiness-token";
      const recoveryRestart = vi.fn(() => {
        throw new Error("Agent mutations must hot-apply without a recovery restart");
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
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const owner = await acquireGatewayLock({
        env: state.env,
        port: claim.port,
        allowInTests: true,
      });
      assert.isNotNull(owner);
      const server = await startGatewayServer(claim.port, {
        gatewayStateOwner: owner,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        hotReloadRecovery: recoveryRestart,
      });
      try {
        await server.startupSettled;
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        try {
          const key = `agent:${agentId}:first-session`;
          let creationAcknowledged = false;
          await expect(
            client.request("agents.create", {
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
          const firstSession = creation
            .then(() => {
              creationAcknowledged = true;
              return client.request("sessions.create", { agentId, key });
            })
            .then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          try {
            await withinTest(
              Promise.race([
                Promise.all([publicationEntered.promise, creationBookkeepingCompleted.promise]),
                firstSession.then((result) => {
                  if (!result.ok) {
                    throw result.error;
                  }
                  throw new Error("Creation finished before reaching the held config publication");
                }),
              ]),
              signal,
            );
            // Finish a wire read after creation bookkeeping, while publication remains held.
            await expect(client.request("agents.list", {})).resolves.toMatchObject({
              agents: expect.not.arrayContaining([expect.objectContaining({ id: agentId })]),
            });
            if (creationAcknowledged) {
              const result = await withinTest(firstSession, signal);
              if (!result.ok) {
                throw result.error;
              }
            }
            expect(
              creationAcknowledged,
              "agents.create acknowledged before runtime publication",
            ).toBe(false);
          } finally {
            releasePublication.resolve();
          }
          await expect(creation).resolves.toMatchObject({ agentId });
          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: expect.arrayContaining([expect.objectContaining({ id: agentId })]),
          });
          const createdSession = await withinTest(firstSession, signal);
          if (!createdSession.ok) {
            throw createdSession.error;
          }
          expect(createdSession.value).toMatchObject({ key });
          await expect(client.request("sessions.list", { agentId })).resolves.toMatchObject({
            sessions: expect.arrayContaining([expect.objectContaining({ key })]),
          });

          await expect(
            client.request("agents.update", {
              agentId,
              name: "Ready Immediately",
              model: "openai/gpt-4.1",
            }),
          ).resolves.toMatchObject({ ok: true, agentId });
          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: expect.arrayContaining([
              expect.objectContaining({ id: agentId, name: "Ready Immediately" }),
            ]),
          });
          expect(
            resolveAgentModelPrimaryValue(getRuntimeConfig().agents?.entries?.[agentId]?.model),
          ).toBe("openai/gpt-4.1");
          await expect(
            client.request("sessions.create", { agentId, key: `agent:${agentId}:after-update` }),
          ).resolves.toMatchObject({ key: `agent:${agentId}:after-update` });

          await expect(
            client.request("agents.delete", { agentId, deleteFiles: false }),
          ).resolves.toMatchObject({ ok: true, agentId });
          for (const incognito of [false, true]) {
            await expect(
              client.request("sessions.create", {
                agentId,
                key: `agent:${agentId}:after-delete`,
                incognito,
              }),
            ).rejects.toThrow(`Unknown agent id "${agentId}"`);
          }
          expect(getRuntimeConfig().agents?.entries?.[agentId]).toBeUndefined();

          const peer = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          try {
            await withinTest(
              Promise.all(
                [client, peer].map(async (operator, index) => {
                  const otherOperator = index === 0 ? peer : client;
                  for (let round = 0; round < 4; round += 1) {
                    const overlapAgentId = `overlap-${index}-${round}`;
                    await expect(
                      operator.request("agents.create", {
                        name: overlapAgentId,
                        workspace: path.join(state.home, overlapAgentId),
                      }),
                    ).resolves.toMatchObject({ agentId: overlapAgentId });
                    await expect(
                      operator.request("sessions.create", {
                        agentId: "main",
                        key: `agent:main:${overlapAgentId}`,
                      }),
                    ).resolves.toMatchObject({ key: `agent:main:${overlapAgentId}` });
                    const deletion = { agentId: overlapAgentId, deleteFiles: false };
                    if (round === 0) {
                      const results = await Promise.allSettled([
                        operator.request("agents.delete", deletion),
                        otherOperator.request("agents.delete", deletion),
                      ]);
                      expect(results).toEqual(
                        expect.arrayContaining([
                          {
                            status: "fulfilled",
                            value: expect.objectContaining({ ok: true, agentId: overlapAgentId }),
                          },
                          {
                            status: "rejected",
                            reason: expect.objectContaining({
                              code: "INVALID_REQUEST",
                              message: `agent "${overlapAgentId}" not found`,
                            }),
                          },
                        ]),
                      );
                    } else {
                      await expect(
                        operator.request("agents.delete", deletion),
                      ).resolves.toMatchObject({
                        ok: true,
                        agentId: overlapAgentId,
                      });
                    }
                  }
                }),
              ),
              signal,
            );
          } finally {
            await disconnectGatewayClient(peer);
          }

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
              const acquire = vi
                .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
                .mockRejectedValue(
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
                expect(
                  (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.[unavailableAgent],
                ).toBeDefined();
                expect(getRuntimeConfig().agents?.entries?.[unavailableAgent]).toBeUndefined();
              } finally {
                acquire.mockRestore();
              }
            }
          } finally {
            unsubscribe();
            scheduleSpy.mockRestore();
            await scheduler.stop();
          }

          const saved = (await readConfigFileSnapshot()).sourceConfig;
          await state.writeConfig({
            ...saved,
            gateway: { ...saved.gateway, reload: { mode: "off" } },
          });
          await expect(
            client.request("agents.create", {
              name: "Saved Only",
              workspace: path.join(state.home, "workspace-saved-only"),
            }),
          ).rejects.toMatchObject({
            code: "UNAVAILABLE",
            message: expect.stringContaining("saved"),
          });
          expect(
            (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.["saved-only"],
          ).toBeDefined();
          expect(getRuntimeConfig().agents?.entries?.["saved-only"]).toBeUndefined();
          expect(recoveryRestart).not.toHaveBeenCalled();
        } finally {
          await disconnectGatewayClient(client);
        }
      } finally {
        await server.close();
        await owner.release();
        await claim.release();
      }
    },
  );
});
