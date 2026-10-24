import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../infra/update-capture-privacy-marker.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync, finishUpdateRunAsync } from "../infra/update-run-write.async.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

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
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_DISABLE_BONJOUR: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
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
          },
        });
        const peers: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
        const pair = async (label: string, scopes: string[]) => {
          const identity = loadOrCreateDeviceIdentity({
            path: state.path(label, "client", "credentials.sqlite"),
          });
          const pending = await requestDevicePairing({
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            clientId: "test",
            clientMode: "backend",
            role: "operator",
            scopes,
          });
          await approveDevicePairing(pending.request.requestId, {
            callerScopes: ["operator.admin"],
          });
          const token = await rotateDeviceToken({
            deviceId: identity.deviceId,
            role: "operator",
            scopes,
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
          const originalBytes = captureBytes(oldCapture);
          const retainedBytes = captureBytes(currentCapture);
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
          const allowed = await client.request<UpdateStepResult>("update.recovery.cleanup", params);
          expect(allowed.advisory).toBeUndefined();
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
