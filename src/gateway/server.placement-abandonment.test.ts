import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.js";
import { getFreePort } from "../../scripts/lib/gateway-bench-probes.js";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../infra/node-commands.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import * as nodeTunnel from "./worker-environments/node-worker-tunnel.js";
import { transport } from "./worker-environments/node-worker-tunnel.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

// Never capture a previous case's spy after a test timeout.
const createTunnel = nodeTunnel.createNodeWorkerTunnelManager;
let fixtureActive = false;

const cases = [
  {
    name: "moves an offline device with a result already pending",
    persisted: false,
    failed: false,
  },
  {
    name: "recovers persisted abandonment after database reopen and in-process Gateway startup",
    persisted: true,
    failed: false,
  },
  {
    name: "recovers persisted abandonment with a different failure after database reopen and in-process Gateway startup",
    persisted: true,
    failed: true,
  },
];

it.for(cases)(
  "$name, completes a fresh turn, and archives deletion",
  { timeout: 90_000 },
  async ({ persisted, failed }, { expect, onTestFinished, signal }) => {
    // A hook timeout also leaves its async cleanup running. Do not let the next
    // case acquire HOME, SQLite, or this module's spy until that owner releases.
    if (fixtureActive) {
      throw new Error("Previous placement abandonment fixture has not released its state");
    }
    fixtureActive = true;
    const bodySettled = createDeferred();
    const fixture = createFixtureLifetime();
    const cleanups: Array<() => unknown> = [];
    let gatewayStopped = true;
    let childStopped = true;
    let bodyFailure: { error: unknown } | undefined;
    // The body owns teardown inside its original 90-second budget. The finish
    // hook only joins that same lifetime if Vitest times out before it settles.
    void fixture.track(bodySettled.promise);
    onTestFinished(async () => {
      await fixture.cleanup();
      fixtureActive = false;
    });
    try {
      const state = await createOpenClawTestState({
        label: "placement-abandonment",
        verifyCleanup: fixture.verifyCleanup,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          // The configured loopback provider uses the built-in Responses adapter.
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
        },
      });
      cleanups.push(async () => {
        if (!gatewayStopped || !childStopped) {
          throw new Error("Placement abandonment fixture still owns Gateway or child state");
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await state.cleanup();
      });
      signal.throwIfAborted();
      const reply = "RECOVERED_SESSION_OK";
      const requestLog = state.path("provider-requests.jsonl");
      const mockPort = await getFreePort();
      signal.throwIfAborted();
      const mock = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH,
          MOCK_PORT: String(mockPort),
          SUCCESS_MARKER: reply,
          MOCK_REQUEST_LOG: requestLog,
        },
      });
      childStopped = false;
      cleanups.push(async () => {
        await stopChild(mock);
        expect(
          inspectManagedProcessGroup(mock, {
            errorPolicy: "indeterminate",
            inspectLeaderWhenNoGroup: true,
          }),
        ).toBe("dead");
        childStopped = true;
      });
      mock.stdout.resume();
      mock.stderr.resume();
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let offlineDeviceSeeded = false;
      let cleaningUp = false;
      const offlineTransport = transport();
      offlineTransport.hasCurrentRunner = () => false;
      offlineTransport.listCurrentNodes = async () => [];
      const offlineNodeLookup = vi.spyOn(offlineTransport, "getCurrentNode");
      const cleanupTransport = transport();
      const cleanupNodes = await cleanupTransport.listCurrentNodes();
      signal.throwIfAborted();
      for (const node of cleanupNodes) {
        node.nodeId = "offline-device";
      }
      cleanupTransport.listCurrentNodes = async () => cleanupNodes;
      const stopInvoke = vi.spyOn(cleanupTransport, "invoke");
      const tunnelFixture = vi
        .spyOn(nodeTunnel, "createNodeWorkerTunnelManager")
        .mockImplementation((options) =>
          createTunnel({
            ...options,
            getTransport: () => (cleaningUp ? cleanupTransport : offlineTransport),
          }),
        );
      cleanups.push(() => tunnelFixture.mockRestore());
      cleanups.push(async () => {
        if (!gateway) {
          return;
        }
        const { client, server, port } = gateway;
        await runQaGatewayFixture(
          () => disconnectGatewayClient(client),
          async () => {
            // Only teardown supplies an acknowledgement for this exact synthetic
            // device. The registered manager still owns draining and shutdown.
            cleaningUp = true;
            await server.close({ reason: "placement abandonment test cleanup" });
            gatewayStopped = true;
            if (offlineDeviceSeeded) {
              expect(stopInvoke).toHaveBeenCalledWith(
                expect.objectContaining({
                  command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
                  params: expect.objectContaining({
                    environmentId: "offline-environment",
                    sessionId: REQUEST.sessionId,
                    ownerEpoch: 1,
                  }),
                }),
              );
            }
            await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
          },
        );
      });
      await expect
        .poll(async () => (await fetch(`http://127.0.0.1:${mockPort}/health`, { signal })).status)
        .toBe(200);
      signal.throwIfAborted();
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${mockPort}/v1`,
        "placement-test",
      );
      const token = "placement-test-token";
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: {
              ...provider.config,
              agentRuntime: { id: "openclaw" },
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { deny: ["*"] },
        gateway: { auth: { mode: "token", token } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      signal.throwIfAborted();
      const start = async () => {
        signal.throwIfAborted();
        gatewayStopped = false;
        gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;
        signal.throwIfAborted();
        return gateway;
      };
      if (!persisted) {
        await start();
      }
      const { sessionId, sessionKey, agentId } = REQUEST;
      const worktreeId = "abandonment-worktree";
      insertRegistryWorktree(process.env, {
        id: worktreeId,
        name: "abandonment",
        repoFingerprint: "fixture",
        repoRoot: state.workspaceDir,
        path: state.workspaceDir,
        branch: "main",
        baseRef: "main",
        ownerKind: "session",
        ownerId: sessionKey,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          agentRuntimeOverride: "openclaw",
          worktree: { id: worktreeId, branch: "main", repoRoot: state.workspaceDir },
        },
      );
      signal.throwIfAborted();
      let database = openOpenClawStateDatabase();
      let placements = createWorkerSessionPlacementStore({ database });
      const environmentId = "offline-environment";
      seedAttachedPlacementEnvironment(database, {
        environmentId,
        sessionId,
        ownerEpoch: 1,
        providerId: "device",
        profileId: "device:offline-device",
        nodeDeviceId: "offline-device",
      });
      offlineDeviceSeeded = true;
      const active = await seedActivePlacement(placements, { environmentId, ownerEpoch: 1 });
      const source = { generation: active.generation, environmentId, ownerEpoch: 1 };
      const claim = await placements.claimTurn({
        sessionId,
        sessionKey,
        agentId,
        claimId: "abandoned-claim",
        runId: "abandoned-run",
        owner: { kind: "worker", environmentId, ownerEpoch: 1 },
      });
      placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      placements.markWorkspaceResultPending(claim);
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      if (persisted) {
        placements.beginPlacementMove({
          sessionId,
          source,
          target: { kind: "gateway" },
          abandonSource: true,
        });
        if (failed) {
          placements.failWorkspaceResultAndReleaseTurn(
            placements.listPendingWorkspaceResults()[0]!,
            "Earlier workspace recovery failed",
          );
          expect(placements.get(sessionId)).toMatchObject({
            state: "failed",
            recoveryError: "Earlier workspace recovery failed",
          });
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await start();
        database = openOpenClawStateDatabase();
        placements = createWorkerSessionPlacementStore({ database });
      }
      if (!gateway) {
        throw new Error("Gateway fixture did not start");
      }
      const { client } = gateway;
      if (!persisted) {
        await expect(
          client.request("sessions.move", {
            key: sessionKey,
            expected: source,
            target: { kind: "gateway" },
            abandonSource: true,
          }),
        ).resolves.toMatchObject({ ok: true, placement: { state: "local" } });
      }
      signal.throwIfAborted();
      expect(placements.get(sessionId)).toMatchObject({ state: "local", turnClaim: null });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.validateTurnClaim(claim)).toBe(false);
      expect(placements.getPlacementMove(sessionId)).toBeUndefined();
      const environments = await createWorkerEnvironmentStore({ database });
      const retainedCleanup = environments.get(environmentId);
      expect(retainedCleanup).toMatchObject({
        state: "attached",
        nodeDeviceId: "offline-device",
        ownerEpoch: 1,
        attachedSessionIds: [sessionId],
        leaseId: `lease:${environmentId}`,
        destroyRequestedAtMs: expect.any(Number),
        teardownTerminalState: "failed",
        lastError: FORCED_WORKER_ABANDONMENT_ERROR,
      });
      const message = `Reply with ${reply} only.`;
      const accepted = await client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      signal.throwIfAborted();
      expect(accepted.runId).not.toBe(claim.runId);
      await expect(
        client.request(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      signal.throwIfAborted();
      const history = await client.request<{ messages: Array<{ role: string; content: unknown }> }>(
        "chat.history",
        { sessionKey },
      );
      signal.throwIfAborted();
      expect(history.messages.filter((item) => item.role === "assistant")).toEqual([
        expect.objectContaining({
          content: [expect.objectContaining({ type: "text", text: reply })],
        }),
      ]);
      const requests = (await fs.readFile(requestLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      signal.throwIfAborted();
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toContain(message);
      expect(requests[0].body).not.toContain(claim.runId);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(sessionId)?.turnClaim).toBeNull();
      const deleted = await client.request<{ deleted: boolean; archived: string[] }>(
        "sessions.delete",
        { key: sessionKey, expectedSessionId: sessionId, deleteTranscript: true },
      );
      signal.throwIfAborted();
      expect(deleted.deleted).toBe(true);
      expect(deleted.archived).toHaveLength(1);
      expect(readSessionArchiveContentSync(deleted.archived[0]!)).toContain(reply);
      expect(loadGatewaySessionEntryReadOnly(sessionKey).entry).toBeUndefined();
      expect(placements.get(sessionId)).toBeUndefined();
      expect(placements.getPlacementMove(sessionId)).toBeUndefined();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(environments.get(environmentId)).toEqual(retainedCleanup);
      expect(offlineNodeLookup).toHaveBeenCalledWith("offline-device");
      expect(stopInvoke).not.toHaveBeenCalled();
    } catch (error) {
      bodyFailure = { error };
    } finally {
      try {
        await runQaGatewayFixture(
          async () => {
            if (bodyFailure) {
              throw bodyFailure.error;
            }
          },
          ...cleanups.toReversed().map(
            (cleanup) => () =>
              fixture.verifyCleanup(async () => {
                await cleanup();
              }),
          ),
        );
      } finally {
        bodySettled.resolve();
      }
    }
  },
);
