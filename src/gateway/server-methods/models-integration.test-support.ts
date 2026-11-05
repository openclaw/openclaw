import { execFile } from "node:child_process";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { expect } from "vitest";
import { listenLoopback as listenModelsEndpoint } from "../../../test/helpers/gateway-integration-fixtures.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

export async function createModelsTestState(
  label: string,
  options: Parameters<typeof createOpenClawTestState>[0] = {},
) {
  const state = await createOpenClawTestState({
    ...options,
    label,
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      ...options.env,
    },
  });
  return Object.assign(state, { [Symbol.asyncDispose]: () => state.cleanup() });
}

export async function startModelsGateway(
  state: OpenClawTestState,
  cfg: Parameters<typeof startGatewayWithClient>[0]["cfg"],
  token: string,
  options: Pick<Parameters<typeof startGatewayWithClient>[0], "hotReloadRecovery"> = {},
) {
  const gateway = await startGatewayWithClient({
    scopes: ["operator.admin"],
    ...options,
    cfg,
    token,
    configPath: state.configPath,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
      closed = true;
    }
  };
  return Object.assign(gateway, { close, [Symbol.asyncDispose]: close });
}

export function modelsTestConfig(
  state: OpenClawTestState,
  token: string,
  overrides: OpenClawConfig = {},
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    ...overrides,
    agents: { entries: { main: { workspace: state.workspaceDir } }, ...overrides.agents },
    gateway: { mode: "local", auth: { mode: "token", token }, ...overrides.gateway },
  };
}

export function settleModelsWork<T>(work: Promise<T>) {
  return work.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
}

export async function connectModelsReader(port: number, token: string) {
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    scopes: ["operator.read"],
  });
  return Object.assign(client, { [Symbol.asyncDispose]: () => disconnectGatewayClient(client) });
}

export { listenModelsEndpoint };

export async function closeModelsEndpoint(server: Server) {
  await promisify(server.close.bind(server))();
}

export async function serveModelsEndpoint(server: Server, rejectErrors = false) {
  const baseUrl = await listenModelsEndpoint(server);
  return {
    baseUrl,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      const closed = closeModelsEndpoint(server);
      await (rejectErrors ? closed : closed.catch(() => {}));
    },
  };
}

// A separate writer supplies no in-process Gateway receipt; refresh must load the durable change.
export async function writeAuthStoreExternally(
  state: OpenClawTestState,
  databasePath: string,
  store: AuthProfileStore | null,
) {
  const result = await promisify(execFile)(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "--eval",
      `
              import { DatabaseSync } from "node:sqlite";
              const database = new DatabaseSync(process.argv[1], { timeout: Number(process.argv[3]) });
              try {
                const result = process.argv[2] === "null"
                  ? database.prepare("DELETE FROM auth_profile_store WHERE store_key = ?").run("primary")
                  : database.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?")
                    .run(process.argv[2], Date.now(), "primary");
                process.stdout.write(String(result.changes));
              } finally {
                database.close();
              }
            `,
      databasePath,
      JSON.stringify(store),
      String(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
    ],
    { env: { ...state.env, NODE_OPTIONS: undefined } },
  );
  expect(result.stdout).toBe("1");
}
