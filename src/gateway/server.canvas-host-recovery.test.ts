import { createServer } from "node:net";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resolveSandboxHostPort } from "../agents/sandbox-host.js";
import { createCanvasDocument } from "../canvas/documents.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayClientRequestError } from "./client.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock } from "./test-helpers.listener.js";

it("recovers Canvas over WebSocket after an occupied sandbox port clears", async () => {
  const claim = await acquireGatewayE2ePortBlock();
  const state = await createOpenClawTestState({
    label: "canvas-host-recovery",
    env: {
      ...KERNEL_TEST_ENV,
      OPENCLAW_SKIP_CANVAS_HOST: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const auth = { mode: "token" as const, token: "synthetic-canvas-recovery" };
  const blocker = createServer();
  const sandboxPort = resolveSandboxHostPort(claim.port);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  const releaseBlocker = () =>
    blocker.listening
      ? new Promise<void>((resolve, reject) => {
          blocker.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
  await runQaGatewayFixture(
    async () => {
      await state.writeConfig({
        gateway: { port: claim.port, auth, controlUi: { enabled: false }, reload: { mode: "off" } },
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(sandboxPort, "127.0.0.1", resolve);
      });
      server = await startGatewayServer(claim.port, {
        bind: "loopback",
        auth,
        controlUiEnabled: false,
      });
      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${claim.port}`,
        token: auth.token,
        scopes: ["operator.admin", "operator.read"],
      });
      const html = "<h1>Synthetic recovered widget</h1>";
      const document = await createCanvasDocument({
        title: "Recovery proof",
        html,
        cspSandbox: "scripts",
      });
      const failure = await client
        .request("canvas.document.view", { docId: document.id })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GatewayClientRequestError);
      expect(failure).toMatchObject({ gatewayCode: "UNAVAILABLE", retryable: true });
      const missing = await client
        .request("canvas.document.view", { docId: "missing-synthetic-widget" })
        .catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(GatewayClientRequestError);
      expect(missing).toMatchObject({ gatewayCode: "UNAVAILABLE", retryable: false });
      await releaseBlocker();
      const recovered = await client.request("canvas.document.view", { docId: document.id });
      expect(recovered).toMatchObject({ html, sandboxPort });
      console.log(
        "Canvas WebSocket recovery trace",
        JSON.stringify({
          occupiedPort: { code: "UNAVAILABLE", retryable: true },
          missingDocument: { code: "UNAVAILABLE", retryable: false },
          releasedPort: { ok: true, exactHtml: true },
        }),
      );
    },
    () => client && disconnectGatewayClient(client),
    () => server?.close(),
    releaseBlocker,
    () => state.cleanup(),
    () => claim.release(),
  );
});
