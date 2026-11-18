import { afterEach, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { waitForGatewayActiveWork } from "../../infra/gateway-active-work.js";
import * as systemDisks from "../../infra/system-disks.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "../gateway.test-support.js";
import { pairOperatorDeviceFixture } from "../paired-device.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "../test-helpers.env.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it(
  "withholds disk paths on authenticated reads and suppresses a revoked in-flight response",
  {
    timeout: 60_000,
  },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "system-info-authority",
        env: createAuthorityGatewayTestEnv(),
      },
      async (state) => {
        const {
          client: admin,
          server,
          port,
        } = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-system-info-token",
          scopes: ["operator.admin"],
          cfg: {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-system-info-token" },
            },
            agents: {
              entries: { main: {} },
              defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            },
            plugins: { enabled: false, slots: { memory: "none" } },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        const clients = [admin];
        const connectDevice = async (label: string, scopes: string[]) => {
          const { identity, issued } = await pairOperatorDeviceFixture({
            identityPath: state.path(label, "client", "credentials.sqlite"),
            scopes,
            tokenScopes: scopes,
            clientId: "test",
            clientMode: "backend",
            callerScopes: ["operator.admin"],
          });
          if (!issued.ok) {
            throw new Error("Expected paired device token");
          }
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            mode: "backend",
            deviceIdentity: identity,
            deviceToken: issued.entry.token,
            scopes,
          });
          clients.push(client);
          return { client, identity };
        };
        const release = createDeferredCore();
        try {
          await server.startupSettled;
          const reader = await connectDevice("reader", ["operator.read"]);
          const before = await reader.client.request<SystemInfoResult>("system.info", {});
          expect(before.diskPath).toBeUndefined();
          expect(before.disks).toBeUndefined();
          expect(before.diskTotalBytes).toBeGreaterThan(0);
          const warm = await admin.request<SystemInfoResult>("system.info", {});
          expect(warm.diskPath).toBe(state.stateDir);
          expect(warm.disks?.length).toBeGreaterThan(0);
          const after = await reader.client.request<SystemInfoResult>("system.info", {});
          expect(after.diskPath).toBeUndefined();
          expect(after.disks).toBeUndefined();
          expect(JSON.stringify(after)).not.toContain(state.stateDir);
          expect(after.diskTotalBytes).toBe(warm.diskTotalBytes);
          expect(after.diskAvailableBytes).toBe(warm.diskAvailableBytes);

          const owner = await connectDevice("revoked-admin", ["operator.admin"]);
          const reached = createDeferredCore();
          const readDisks = systemDisks.readSystemDisks;
          // Delay external I/O only; authenticated dispatch and final response guards stay real.
          vi.spyOn(systemDisks, "readSystemDisks").mockImplementationOnce(async () => {
            const disks = await readDisks();
            reached.resolve();
            await release.promise;
            return disks;
          });
          const reply = owner.client.request("system.info", {}).then(
            (payload: unknown) => ({ payload }),
            (error: unknown) => ({ error }),
          );
          await withinTest(reached.promise, signal);
          await admin.request("device.token.revoke", {
            deviceId: owner.identity.deviceId,
            role: "operator",
          });
          release.resolve();
          expect((await withinTest(waitForGatewayActiveWork(10_000), signal)).drained).toBe(true);
          expect(await withinTest(reply, signal)).toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining("gateway closed (4001)"),
            }),
          });
          expect((await admin.request<SystemInfoResult>("system.info", {})).diskPath).toBe(
            state.stateDir,
          );
        } finally {
          release.resolve();
          await Promise.all(clients.map(disconnectGatewayClient));
          await server.close({ reason: "system-info-authority proof complete" });
        }
      },
    );
  },
);
