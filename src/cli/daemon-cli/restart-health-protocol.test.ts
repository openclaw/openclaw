import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import * as gatewayCall from "../../gateway/call.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withUpdateCommandExecutor } from "../update-cli/update-command-executor.js";
import { useExecutorFixture } from "../update-cli/update-command-executor.test-support.js";
import { confirmGatewayReachable } from "./restart-health-probe.js";
import { withProtocolGateway } from "./restart-health-protocol.test-support.js";

// The old updater's transport must not decide whether the new Gateway is healthy.
const retainedProtocol = MIN_CLIENT_PROTOCOL_VERSION - 1;
it.each(["none", "token"] as const)(
  "old/current local readiness control with %s auth",
  async (mode) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined } },
      async (state) =>
        withProtocolGateway(mode, async ({ port, config, httpRequests }) => {
          const controlAuth = await resolveReadOnlyLocalGatewayAuth({
            auth: config.gateway?.auth,
            authNone: mode === "none",
            env: state.env,
          });
          const probe = (protocol: number) =>
            gatewayCall.callGateway({
              config,
              localPortOverride: port,
              ...controlAuth,
              method: "health",
              scopes: ["operator.read"],
              timeoutMs: 2_000,
              minProtocol: protocol,
              maxProtocol: protocol,
            });
          await expect(probe(retainedProtocol)).rejects.toThrow(/protocol mismatch/);
          await expect(probe(PROTOCOL_VERSION)).resolves.toMatchObject({ ok: true });
          const actualCallGateway = gatewayCall.callGateway;
          vi.spyOn(gatewayCall, "callGateway").mockImplementation((options) =>
            actualCallGateway({
              ...options,
              minProtocol: retainedProtocol,
              maxProtocol: retainedProtocol,
            }),
          );
          await expect(
            confirmGatewayReachable({
              port,
              config,
              auth: config.gateway.auth,
              env: state.env,
              allowHttpVerification: true,
              timeoutMs: 2_000,
            }),
          ).resolves.toMatchObject({
            reachable: true,
            gatewayVersion: "2026.10.23",
            gatewayBuildId: "fixture-target",
            protocolMismatch: expect.stringContaining("protocol mismatch"),
          });
          expect(httpRequests).toEqual(expect.arrayContaining(["/startupz", "/readyz"]));
        }),
    );
  },
);

const executorFixture = useExecutorFixture("readiness-connection-authority-");
it.each([false, true])("real executor readiness with reassigned=%s", async (reassigned) => {
  const { root, control } = executorFixture();
  await withOpenClawTestState(
    { env: { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined } },
    async (state) =>
      withProtocolGateway(
        "token",
        async ({ port, config, observed, requests }) => {
          let callError: unknown;
          const outcome = await withUpdateCommandExecutor(randomUUID(), async (owner) => {
            const fence = await owner.enter(root);
            return confirmGatewayReachable({
              config,
              auth: config.gateway.auth,
              env: state.env,
              port,
              timeoutMs: 2_000,
              assertCurrent: fence.assertCurrent,
            }).catch((error: unknown) => {
              callError = error;
              throw error;
            });
          }).catch((error: unknown) => error);
          if (!reassigned) {
            expect(requests).toEqual(["connect", "health"]);
            expect(Boolean(observed[0]?.auth?.token)).toBe(true);
            expect(outcome).toMatchObject({
              reachable: true,
              gatewayVersion: "2026.10.23",
              gatewayBuildId: "fixture-target",
            });
            expect(callError).toBeUndefined();
            return;
          }
          expect(requests).toEqual([]);
          expect(outcome).toBe(callError);
          expect(callError).toMatchObject({
            message: "Update executor ownership is no longer current.",
          });
        },
        {
          beforeChallenge: async () => {
            if (!reassigned) {
              return;
            }
            // Reassign the real admitted lease while the live socket awaits its challenge.
            const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            try {
              const changed = db
                .prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?")
                .run("replacement", root);
              expect(changed.changes).toBe(1);
            } finally {
              db.close();
            }
          },
        },
      ),
  );
});
