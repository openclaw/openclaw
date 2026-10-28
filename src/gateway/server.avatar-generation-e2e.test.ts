import { createServer, type ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGardenKeeperDesign } from "./avatar-design.test-support.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { pairOperatorDeviceFixture } from "./paired-device.test-support.js";
import { startGatewayServerCore } from "./server-start.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const token = "avatar-generation-e2e-bootstrap";
const routeGate = vi.hoisted(() => ({ pause: null as null | (() => Promise<void>) }));

// Keep the production route resolver; the one-shot gate only controls when a revoked request resumes.
vi.mock("../agents/isolated-completion-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/isolated-completion-route.js")>();
  return {
    ...actual,
    resolveIsolatedCompletionRoute: async (
      ...args: Parameters<typeof actual.resolveIsolatedCompletionRoute>
    ) => {
      const pause = routeGate.pause;
      if (pause) {
        routeGate.pause = null;
        await pause();
      }
      return actual.resolveIsolatedCompletionRoute(...args);
    },
  };
});
const design = createGardenKeeperDesign(
  "A friendly gardener with a cream apron.",
  '<path d="M35 49 L85 49 L88 84 Q60 99 32 84 Z" fill="#f1e4c4"/>',
);

function respond(response: ServerResponse, id: string, content = JSON.stringify(design)) {
  writeOpenAiResponsesSse(response, [
    {
      id,
      object: "chat.completion.chunk",
      model: "avatar-model",
      choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
    },
  ]);
}

it(
  "generates through authenticated RPC and provider I/O, rejecting read-only and revoked callers",
  { timeout: 120_000 },
  async ({ signal }) => {
    const state = await createOpenClawTestState({
      label: "avatar-generation-e2e",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    const responses: ServerResponse[] = [];
    let holdSecond = false;
    const provider = createServer((request, response) => {
      request.resume();
      const index = responses.push(response) - 1;
      arrivals[index]?.resolve();
      if (index !== 1 || !holdSecond) {
        respond(response, `avatar-response-${index}`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => {
        provider.removeListener("error", reject);
        resolve();
      });
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing local completion provider listener");
    }
    const clients: GatewayClient[] = [];
    let gateway: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
    try {
      const claim = await acquireGatewayE2ePortBlock();
      await state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        logging: { level: "silent", consoleLevel: "silent" },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "avatar-proof/avatar-model" },
          },
        },
        models: {
          providers: {
            "avatar-proof": {
              api: "openai-completions",
              apiKey: "synthetic-local-provider-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                modelDefinition("avatar-model", {
                  name: "Avatar model",
                  reasoning: false,
                  contextWindow: 8192,
                  maxTokens: 1024,
                }),
              ],
            },
          },
        },
      });
      gateway = await startClaimedGateway(claim, () =>
        startGatewayServerCore(claim.port, { controlUiEnabled: false }),
      );
      await gateway.startupSettled;

      const connect = async (options: {
        scopes: string[];
        token?: string;
        deviceToken?: string;
        deviceIdentity?: GatewayClientOptions["deviceIdentity"];
      }) => {
        const ready = createDeferred<HelloOk>();
        const closed = createDeferred();
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          clientName: options.deviceToken ? "test" : "gateway-client",
          clientVersion: "1.0.0",
          platform: "test",
          mode: options.deviceToken ? "test" : "backend",
          deviceIdentity: null,
          ...options,
          hostDeps: {
            loadDeviceAuthToken: () => null,
            storeDeviceAuthToken: () => {},
            clearDeviceAuthToken: () => {},
          },
          onHelloOk: (hello) => ready.resolve(hello),
          onConnectError: (error) => ready.reject(error),
          onClose: () => closed.resolve(),
        });
        clients.push(client);
        client.start();
        await withinTest(ready.promise, signal);
        return { client, closed: closed.promise };
      };
      const pair = async (name: string, scopes: string[]) => {
        const { identity, issued } = await pairOperatorDeviceFixture({
          identityPath: state.path(name, "client", "credentials.sqlite"),
          scopes,
          tokenScopes: scopes,
          clientId: "test",
          clientMode: "test",
          callerScopes: ["operator.admin"],
        });
        if (!issued.ok) {
          throw new Error("Could not issue synthetic device token");
        }
        return {
          identity,
          connection: await connect({
            scopes,
            deviceIdentity: identity,
            deviceToken: issued.entry.token,
          }),
        };
      };

      const bootstrap = await connect({ scopes: ["operator.admin"], token });
      const generate = (client: GatewayClient) =>
        client.request<{ svg: string; name: string }>("agents.avatar.generate", {
          agentId: "main",
          prompt: "A gardener",
        });
      const revoke = async ({ identity, connection }: Awaited<ReturnType<typeof pair>>) => {
        await bootstrap.client.request("device.token.revoke", {
          deviceId: identity.deviceId,
          role: "operator",
        });
        await withinTest(connection.closed, signal);
      };
      const observe = (pending: Promise<unknown>) =>
        pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      const admin = await pair("admin", ["operator.admin"]);
      const reader = await pair("reader", ["operator.read"]);
      const first = await generate(admin.connection.client);
      expect(first.svg).toContain("<svg");
      expect(first.name).toBe("Garden Keeper");
      expect(responses).toHaveLength(1);

      await expect(generate(reader.connection.client)).rejects.toThrow(
        "missing scope: operator.admin",
      );
      expect(responses).toHaveLength(1);

      const revokedBeforeDispatch = await pair("revoked-before-dispatch", ["operator.admin"]);
      const routeEntered = createDeferred();
      const releaseRoute = createDeferred();
      routeGate.pause = async () => {
        routeEntered.resolve();
        await releaseRoute.promise;
      };
      const beforeSettled = observe(generate(revokedBeforeDispatch.connection.client));
      await withinTest(routeEntered.promise, signal);
      await revoke(revokedBeforeDispatch);
      releaseRoute.resolve();
      expect(await withinTest(beforeSettled, signal)).toHaveProperty("error");
      expect(responses).toHaveLength(1);

      const revoked = await pair("revoked", ["operator.admin"]);
      holdSecond = true;
      const settled = observe(generate(revoked.connection.client));
      await withinTest(arrivals[1]!.promise, signal);
      await revoke(revoked);
      respond(responses[1]!, "avatar-revoked", "invalid design");
      expect(await withinTest(settled, signal)).toHaveProperty("error");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(responses).toHaveLength(2);
    } finally {
      routeGate.pause = null;
      for (const response of responses) {
        response.end();
      }
      await runQaGatewayFixture(
        async () => {},
        ...clients.map((client) => () => client.stopAndWait()),
        async () => gateway?.close(),
        () => state.cleanup(),
        () =>
          new Promise<void>((resolve) => {
            provider.close(() => resolve());
          }),
      );
    }
  },
);
