import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.js";
import { getFreePort } from "../../scripts/lib/gateway-bench-probes.js";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
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
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
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
  { name: "offline move", persisted: false, failed: false },
  { name: "database reopen", persisted: true, failed: false },
  { name: "failed recovery reopen", persisted: true, failed: true },
];

it.for(cases)(
  "$name: abandons the pending worker result, completes a fresh turn, and archives deletion",
  { timeout: 90_000 },
  async ({ persisted, failed }, { expect, onTestFinished, signal }) => {
    // Timeout cleanup must release HOME, SQLite, and the spy before another case.
    if (fixtureActive) {
      throw new Error("Previous placement abandonment fixture has not released its state");
    }
    fixtureActive = true;
    const cleanups: Array<() => unknown> = [];
    let gatewayStopped = true;
    let childStopped = true;
    const owner = { environmentId: "offline-environment", ownerEpoch: 1 };
    const { environmentId } = owner;
    await runQaGatewayTestFixture(
      {
        signal,
        onTestFinished(cleanup) {
          onTestFinished(async (context) => {
            await cleanup(context);
            fixtureActive = false;
          });
        },
      },
      async (fixture) => {
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
              // Only teardown acknowledges this offline device; the real manager drains it.
              cleaningUp = true;
              await server.close({ reason: "placement abandonment test cleanup" });
              gatewayStopped = true;
              if (offlineDeviceSeeded) {
                expect(stopInvoke).toHaveBeenCalledWith(
                  expect.objectContaining({
                    command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
                    params: expect.objectContaining({
                      ...owner,
                      sessionId: REQUEST.sessionId,
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
        const agentRuntime = { id: "openclaw" } as const;
        const model = {
          agentRuntime,
          params: { transport: "sse", openaiWsWarmup: false },
        };
        const providerConfig = {
          ...provider.config,
          agentRuntime,
          request: { allowPrivateNetwork: true },
        };
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef },
              models: { [provider.modelRef]: model },
            },
          },
          models: { mode: "replace", providers: { [provider.providerId]: providerConfig } },
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
        } else {
          await captureRuntimeConfigAsyncReader()();
        }
        const { sessionId, sessionKey, agentId } = REQUEST;
        const session = { sessionId, sessionKey, agentId };
        const worktreeId = "abandonment-worktree";
        await insertRegistryWorktree(process.env, {
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
        seedAttachedPlacementEnvironment(database, {
          ...owner,
          sessionId,
          providerId: "device",
          profileId: "device:offline-device",
          nodeDeviceId: "offline-device",
        });
        offlineDeviceSeeded = true;
        const active = await seedActivePlacement(placements, owner);
        const source = { generation: active.generation, ...owner };
        const claim = await placements.claimTurn({
          ...session,
          claimId: "abandoned-claim",
          runId: "abandoned-run",
          owner: { kind: "worker", ...owner },
        });
        await placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
        await placements.markWorkspaceResultPending(claim);
        expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        if (persisted) {
          await placements.beginPlacementMove({
            sessionId,
            source,
            target: { kind: "gateway" },
            abandonSource: true,
          });
          if (failed) {
            await placements.failWorkspaceResultAndReleaseTurn(
              (await placements.listPendingWorkspaceResultsAsync())[0]!,
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
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(placements.validateTurnClaim(claim)).toBe(false);
        expect(await placements.getPlacementMoveAsync(sessionId)).toBeUndefined();
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
        const history = await client.request<{
          messages: Array<{ role: string; content: unknown }>;
        }>("chat.history", { sessionKey });
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
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(placements.get(sessionId)?.turnClaim).toBeNull();
        const deleted = await client.request<{ deleted: boolean; archived: string[] }>(
          "sessions.delete",
          { key: sessionKey, expectedSessionId: sessionId, deleteTranscript: true },
        );
        signal.throwIfAborted();
        expect(deleted).toMatchObject({ deleted: true, archived: [expect.any(String)] });
        expect(readSessionArchiveContentSync(deleted.archived[0]!)).toContain(reply);
        expect((await loadGatewaySessionEntryReadOnlyAsync(sessionKey)).entry).toBeUndefined();
        expect(placements.get(sessionId)).toBeUndefined();
        expect(await placements.getPlacementMoveAsync(sessionId)).toBeUndefined();
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(environments.get(environmentId)).toEqual(retainedCleanup);
        expect(offlineNodeLookup).toHaveBeenCalledWith("offline-device");
        expect(stopInvoke).not.toHaveBeenCalled();
      },
      () => runQaGatewayFixture(async () => {}, ...cleanups.toReversed()),
    );
  },
);
