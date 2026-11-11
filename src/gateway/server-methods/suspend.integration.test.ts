import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySuspendPrepareResult } from "../../../packages/gateway-protocol/src/index.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "../gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "../test-helpers.env.js";

// Enable the production owner which ordinary in-process Gateway tests skip.
vi.mock("../../infra/gateway-lock.js", async (original) => {
  const actual = await original<typeof import("../../infra/gateway-lock.js")>();
  return {
    ...actual,
    acquireGatewayLock: (options: Parameters<typeof actual.acquireGatewayLock>[0]) =>
      actual.acquireGatewayLock({ ...options, allowInTests: true }),
  };
});

afterEach(resetGatewayTestState);

it(
  "keeps a completion wait routable while rejecting independent work",
  { timeout: 60_000 },
  async () => {
    await withOpenClawTestState(
      { label: "completion-wait-transport", env: createAuthorityGatewayTestEnv() },
      async (state) => {
        const token = "synthetic-completion-wait-token";
        const { client, server, port } = await startGatewayWithClient({
          configPath: state.configPath,
          token,
          scopes: ["operator.admin"],
          cfg: {
            gateway: { mode: "local", auth: { mode: "token", token } },
            agents: {
              entries: { main: {} },
              defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            },
            plugins: { enabled: false, slots: { memory: "none" } },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        const clients = [client];
        const admitted = tryBeginGatewayRootWorkAdmission("completion-transport-proof");
        try {
          expect(admitted).not.toBeNull();
          await server.startupSettled;
          expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
          const request = {
            requestId: "planned-update",
            completionDeadlineMs: Date.now() + 60_000,
          };
          const held = await client.request<GatewaySuspendPrepareResult>(
            "gateway.suspend.prepare",
            request,
          );
          expect(held.status).toBe("draining");
          if (held.status !== "draining") {
            throw new Error("Expected an admitted-work completion wait");
          }
          expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
          await expect(
            client.request("chat.send", {
              sessionKey: "agent:main:completion-transport-proof",
              message: "must not execute",
              idempotencyKey: "rejected-during-completion",
            }),
          ).rejects.toThrow(/paused|suspend|unavailable/i);
          const reconnected = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token,
            scopes: ["operator.admin"],
          });
          clients.push(reconnected);
          expect(await reconnected.request("gateway.suspend.prepare", request)).toMatchObject({
            status: "draining",
            suspensionId: held.suspensionId,
          });
          admitted?.release();
          // Socket and startup owners may still be settling after the response.
          await expect
            .poll(
              () =>
                reconnected.request("gateway.suspend.status", { suspensionId: held.suspensionId }),
              { timeout: 5_000 },
            )
            .toMatchObject({ status: "ready" });
          expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
          await reconnected.request("gateway.suspend.resume", { suspensionId: held.suspensionId });
          expect(
            await reconnected.request("gateway.suspend.status", {
              suspensionId: held.suspensionId,
            }),
          ).toMatchObject({ status: "running" });
        } finally {
          admitted?.release();
          await Promise.all(clients.map(disconnectGatewayClient));
          await server.close({ reason: "completion transport proof finished" });
        }
      },
    );
  },
);
