import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import * as cronLifecycle from "../cron/service/ops-lifecycle.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

it("applies agent creation after detached cron startup with CLI service facts", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({
    label: "config-service-context",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const token = "config-service-context-token";
  const started = createDeferred();
  const startCron = cronLifecycle.start;
  const startup = vi.spyOn(cronLifecycle, "start").mockImplementation(async (cronState) => {
    try {
      await startCron(cronState);
      started.resolve();
    } catch (error) {
      started.reject(error);
      throw error;
    }
  });
  void started.promise.catch(() => undefined);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  await runQaGatewayFixture(
    () =>
      withGatewayServiceInstallation(
        {
          installation: {
            root: path.join(state.home, "global-installation"),
            version: "2026.7.1",
            cliVersion: "2026.10.9",
            databasePath: path.join(state.home, "global-state", "openclaw.sqlite"),
          },
        },
        async () => {
          await state.writeConfig({
            gateway: { mode: "local", auth: { mode: "token", token } },
            agents: {
              ownership: "explicit",
              defaults: { skipBootstrap: true, model: "openai/gpt-4.1" },
              entries: { main: { workspace: state.workspaceDir } },
            },
            plugins: { slots: { memory: "none" } },
          });
          server = await startGatewayServer(claim.port, {
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
            hotReloadRecovery: () => {
              throw new Error("Creation must apply without a recovery restart");
            },
          });
          await server.startupSettled;
          await withinTest(started.promise, signal);
          client = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          await expect(
            client.request("agents.create", {
              agentId: "service-context-agent",
              name: "Service Context Agent",
              workspace: path.join(state.home, "workspace-created"),
              onboarding: false,
            }),
          ).resolves.toMatchObject({ agentId: "service-context-agent" });
          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: expect.arrayContaining([
              expect.objectContaining({ id: "service-context-agent" }),
            ]),
          });
        },
      ),
    () => client && disconnectGatewayClient(client),
    () => server?.close(),
    () => startup.mockRestore(),
    () => claim.release(),
    () => state.cleanup(),
  );
});
