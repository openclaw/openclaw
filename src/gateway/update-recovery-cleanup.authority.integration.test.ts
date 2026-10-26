import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../agents/tools/gateway-tool.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../infra/update-capture-privacy-marker.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync, finishUpdateRunAsync } from "../infra/update-run-write.async.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import { pairOperatorDeviceFixture } from "./paired-device.test-support.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "./test-helpers.env.js";

const observation = vi.hoisted(() => ({
  request: (_request: GatewayRequestOptions) => {},
  settled: (_request: GatewayRequestOptions) => {},
  beforeAdmission: () => {},
}));

// Enable the production Gateway lock which ordinary in-process tests skip.
vi.mock("../infra/gateway-lock.js", async (original) => {
  const actual = await original<typeof import("../infra/gateway-lock.js")>();
  return {
    ...actual,
    acquireGatewayLock: (options: Parameters<typeof actual.acquireGatewayLock>[0]) =>
      actual.acquireGatewayLock({ ...options, allowInTests: true }),
  };
});

// Observe the real authenticated dispatcher; do not replace admission or the handler.
vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async (original) => {
    const actual =
      await original<
        typeof import("./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js")
      >();
    return {
      ...actual,
      handleGatewayRequest: async (...args: Parameters<typeof actual.handleGatewayRequest>) => {
        observation.request(args[0]);
        try {
          return await actual.handleGatewayRequest(...args);
        } finally {
          observation.settled(args[0]);
        }
      },
    };
  },
);

// The hook observes a completed filesystem effect, then invokes the real device
// revocation owner. The original host admission still decides every grant/refusal.
vi.mock("../infra/sqlite-worker-operation-admission.js", async (original) => {
  const actual = await original<typeof import("../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...[admit, attachment]: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        observation.beforeAdmission();
        admit(request, grant);
      }, attachment),
  };
});

afterEach(() => {
  observation.request = () => {};
  observation.settled = () => {};
  observation.beforeAdmission = () => {};
  vi.restoreAllMocks();
  resetGatewayTestState();
});

function capture(stateDir: string, runId: string) {
  const directory = path.join(resolveUpdateCaptureRoot(stateDir), runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  fs.writeFileSync(path.join(directory, "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(directory, "original-a"), "original a");
  fs.writeFileSync(path.join(directory, "original-b"), "original b");
  return directory;
}

function captureBytes(directory: string) {
  const identity = fs.statSync(directory, { bigint: true });
  return {
    identity: { dev: identity.dev, ino: identity.ino, mode: identity.mode },
    files: Object.fromEntries(
      fs
        .readdirSync(directory)
        .toSorted()
        .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
    ),
  };
}

it(
  "fences real cleanup RPC deletion by authenticated scope, owner identity, and mid-removal device revocation",
  { timeout: 90_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "recovery-cleanup-authority",
        env: createAuthorityGatewayTestEnv(),
      },
      async (state) => {
        const now = Date.now();
        const completedRun = (started: number) => {
          using clock = vi.spyOn(Date, "now");
          clock.mockReturnValue(started);
          const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
          clock.mockReturnValue(started + 10_000);
          finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
          return run.runId;
        };
        const old = completedRun(now - 180_000);
        const current = completedRun(now - 90_000);
        const oldCapture = capture(state.stateDir, old);
        const currentCapture = capture(state.stateDir, current);
        await closeOpenClawStateDatabaseAsync();
        const { client, server, port } = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-cleanup-token",
          scopes: ["operator.admin"],
          cfg: {
            gateway: { mode: "local", auth: { mode: "token", token: "synthetic-cleanup-token" } },
            agents: {
              entries: { main: {} },
              defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            },
            plugins: { enabled: false, slots: { memory: "none" } },
            models: { catalogRefresh: { enabled: false } },
            cron: { enabled: false },
            update: { checkOnStart: false },
            commands: { ownerAllowFrom: ["owner"], restart: false },
          },
        });
        const peers: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
        const pair = async (label: string, scopes: string[]) => {
          const { identity, issued: token } = await pairOperatorDeviceFixture({
            identityPath: state.path(label, "client", "credentials.sqlite"),
            scopes,
            tokenScopes: scopes,
            clientId: "test",
            clientMode: "backend",
            callerScopes: ["operator.admin"],
          });
          if (!token.ok) {
            throw new Error("Expected a paired test device");
          }
          const connected = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            mode: "backend",
            deviceIdentity: identity,
            deviceToken: token.entry.token,
            scopes,
          });
          peers.push(connected);
          return { connected, identity };
        };
        try {
          await server.startupSettled;
          const owner = captureGatewayStateOwner(resolveOpenClawStateSqlitePath(state.env));
          expect(owner?.ownerId).toBeTruthy();
          const params = { runId: current, expectedOwnerId: owner!.ownerId };
          await expect(
            client.request("update.recovery.cleanup", { ...params, dryRun: true }),
          ).rejects.toThrow("invalid update.recovery.cleanup params");
          const originalBytes = captureBytes(oldCapture);
          const retainedBytes = captureBytes(currentCapture);
          let gatewayContext: GatewayRequestContext | undefined;
          observation.request = (request) => {
            gatewayContext = request.context;
          };
          const readOnly = await pair("read-only", ["operator.read"]);
          await expect(
            readOnly.connected.request("update.recovery.cleanup", params),
          ).rejects.toThrow("missing scope: operator.admin");
          expect(captureBytes(oldCapture)).toEqual(originalBytes);
          expect(captureBytes(currentCapture)).toEqual(retainedBytes);
          await expect(
            client.request("update.recovery.cleanup", { ...params, expectedOwnerId: randomUUID() }),
          ).rejects.toThrow(/owner|requester/i);
          expect(captureBytes(oldCapture)).toEqual(originalBytes);
          expect(captureBytes(currentCapture)).toEqual(retainedBytes);
          const tool = createGatewayTool({
            senderIsOwner: true,
            requesterSenderId: "owner",
            allowConfigReads: false,
          });
          const invoke = (dryRun: boolean) =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:maintenance",
                turnSourceChannel: "slack",
                gatewayContextResolver: () => gatewayContext,
              },
              () =>
                tool.execute("cleanup", {
                  action: "update.cleanup",
                  dryRun,
                  gatewayUrl: "wss://wrong-gateway.invalid",
                  expectedOwnerId: "forged",
                }),
            );
          const refused = await createGatewayTool({ senderIsOwner: false }).execute("cleanup", {
            action: "update.cleanup",
            senderIsOwner: true,
          });
          expect(refused.details).toMatchObject({ ok: false, code: "owner_required" });
          const preview = await invoke(true);
          expect(preview.details).toMatchObject({ status: "preview", totals: { removedFiles: 0 } });
          expect(captureBytes(oldCapture)).toEqual(originalBytes);
          expect(captureBytes(currentCapture)).toEqual(retainedBytes);
          const allowed = await invoke(false);
          expect(allowed.details).toMatchObject({
            status: "complete",
            totals: { removedFiles: 1 },
          });
          expect(await client.request("health", {})).toBeTruthy();
          expect(fs.existsSync(oldCapture)).toBe(false);
          expect(fs.existsSync(currentCapture)).toBe(true);

          const next = await createUpdateRunAsync({ trigger: "cli" }, { env: state.env });
          const nextCapture = capture(state.stateDir, next.runId);
          const nextBytes = captureBytes(nextCapture);
          await finishUpdateRunAsync(next.runId, { status: "succeeded" }, { env: state.env });
          const revocable = await pair("revocable", ["operator.admin"]);
          const files = ["manifest.json", "original-a", "original-b"].map((name) =>
            path.join(currentCapture, name),
          );
          const settled = createDeferredCore();
          let active: GatewayRequestOptions | undefined;
          let revoked = false;
          observation.request = (request) => {
            if (
              request.req.method === "update.recovery.cleanup" &&
              request.client?.connect.device?.id === revocable.identity.deviceId
            ) {
              active = request;
            }
          };
          observation.settled = (request) => {
            if (request === active) {
              settled.resolve();
            }
          };
          observation.beforeAdmission = () => {
            if (!revoked && active && files.some((file) => !fs.existsSync(file))) {
              revoked = true;
              const invalidate = active.context.invalidateClientsForDevice;
              if (!invalidate) {
                throw new Error("Authenticated Gateway context lacks its revocation owner");
              }
              invalidate(revocable.identity.deviceId, {
                role: "operator",
                reason: "synthetic-mid-removal-revocation",
              });
            }
          };
          const reply = revocable.connected
            .request("update.recovery.cleanup", {
              runId: next.runId,
              expectedOwnerId: owner!.ownerId,
            })
            .then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
          await withinTest(settled.promise, signal);
          expect(await reply).toHaveProperty("error");
          expect(revoked).toBe(true);
          expect(files.filter((file) => !fs.existsSync(file))).toHaveLength(1);
          expect(fs.existsSync(path.join(currentCapture, UPDATE_CAPTURE_PRIVACY_MARKER))).toBe(
            true,
          );
          expect(captureBytes(nextCapture)).toEqual(nextBytes);
          expect((await getUpdateRunAsync(next.runId, { env: state.env }))?.status).toBe(
            "succeeded",
          );
          owner!.assertCurrent();
          observation.beforeAdmission = () => {};
          const latest = await createUpdateRunAsync({ trigger: "cli" }, { env: state.env });
          const latestCapture = capture(state.stateDir, latest.runId);
          const latestBytes = captureBytes(latestCapture);
          await finishUpdateRunAsync(latest.runId, { status: "succeeded" }, { env: state.env });
          const nextFiles = ["manifest.json", "original-a", "original-b"].map((name) =>
            path.join(nextCapture, name),
          );
          let ownerRevoked = false;
          const commands = gatewayContext!.getRuntimeConfig().commands!;
          observation.beforeAdmission = () => {
            if (!ownerRevoked && nextFiles.some((file) => !fs.existsSync(file))) {
              ownerRevoked = true;
              // Publish the synthetic config's revocation in place so only the
              // real command-owner guard, not a config-reference check, can stop it.
              commands.ownerAllowFrom = [];
            }
          };
          try {
            expect((await invoke(false)).details).toMatchObject({ status: "blocked" });
            expect(ownerRevoked).toBe(true);
            expect(nextFiles.filter((file) => !fs.existsSync(file))).toHaveLength(1);
            expect(captureBytes(latestCapture)).toEqual(latestBytes);
          } finally {
            observation.beforeAdmission = () => {};
            commands.ownerAllowFrom = ["owner"];
          }
          console.info(
            "cleanup RPC proof: allowed deletion; non-admin and wrong owner denied; real device revocation after one removal prevented subsequent deletion; current capture and successful outcome retained",
          );
        } finally {
          observation.beforeAdmission = () => {};
          observation.request = () => {};
          observation.settled = () => {};
          for (const peer of peers) {
            await disconnectGatewayClient(peer);
          }
          await disconnectGatewayClient(client);
          await server.close({ reason: "cleanup authority proof complete" });
        }
      },
    );
  },
);
