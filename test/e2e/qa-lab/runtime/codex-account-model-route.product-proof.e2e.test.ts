// QA Lab proof: models the ChatGPT account lists run on the default Codex harness, exactly as the
// picker offers them. Catalog rows come only from fixture HTTP and app-server responses.
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

/** Listed by the account only; absent from every static OpenAI route list. */
const ACCOUNT_ONLY_MODEL = "gpt-account-only-fixture";
/** The manifest names only its Platform row; the account lists the ChatGPT row. */
const DAYBREAK_MODEL = "gpt-daybreak-blue-latest";
/** Known dual-route control. */
const DUAL_ROUTE_MODEL = "gpt-6-sol";
const ACCOUNT_MODELS = [ACCOUNT_ONLY_MODEL, DAYBREAK_MODEL, DUAL_ROUTE_MODEL];
const PLATFORM_MODELS = [DAYBREAK_MODEL, DUAL_ROUTE_MODEL];
const ACCOUNT_ID = "qa-codex-route-account";
const OAUTH_PROFILE_ID = "openai:qa-oauth";
const API_KEY_PROFILE_ID = "openai:qa-api-key";
const API_KEY = "sk-qa-codex-route-fixture";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const REQUEST_TIMEOUT_MS = 60_000;

const oauthAccess = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
  ).toString("base64url"),
  "test-signature",
].join(".");

type AppServerLogEntry = { id?: number | string; method?: string; params?: unknown };
type Credentials = "chatgpt" | "chatgpt+api-key" | "api-key";

let instance: OpenClawTestInstance | undefined;
let receipts: FixtureReceiptChannel;
let receiptClientUrl: string;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
  const clientPath = path.join(tempDirs.make("codex-route-receipts-"), "client.mjs");
  await fs.writeFile(
    clientPath,
    `${fixtureReceiptClientSource(receipts.endpoint)}
export { sendReceipt };
`,
  );
  receiptClientUrl = pathToFileURL(clientPath).href;
});

afterAll(async () => {
  await receipts?.close();
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

/** Serves the ChatGPT and Platform model lists the preload routes to this loopback origin. */
async function startModelListFixture() {
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body =
      requestPath === "/catalog/models"
        ? {
            models: ACCOUNT_MODELS.map((slug) => ({
              slug,
              display_name: slug,
              visibility: "list",
              show_in_picker: true,
              context_window: 128_000,
              max_output_tokens: 4096,
            })),
          }
        : requestPath === "/platform/models"
          ? {
              object: "list",
              data: PLATFORM_MODELS.map((id) => ({
                id,
                object: "model",
                created: 0,
                owned_by: "openai",
              })),
            }
          : undefined;
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("model list fixture did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function startRouteGateway(credentials: Credentials) {
  const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
    CODEX_APP_SERVER_VERSION: string;
  }>({ pluginId: "codex", artifactBasename: "test-api.js" });
  const modelLists = await startModelListFixture();
  const root = tempDirs.make("codex-route-");
  const clockFile = path.join(root, "clock-offset");
  await fs.writeFile(clockFile, "0");
  // Routes the real openai catalog hook, including inside the catalog worker, to the fixture.
  const preload = new URL("./quota-reset-preload.mjs", import.meta.url);
  preload.searchParams.set("fixture", modelLists.baseUrl);
  preload.searchParams.set("clock", clockFile);
  preload.searchParams.set("catalog", "1");
  preload.searchParams.set("platformCatalog", "1");
  const appServerFixture = fileURLToPath(
    new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
  );
  const gateway = await createOpenClawTestInstance({
    name: `qa-codex-account-model-route-${credentials.replace("+", "-")}`,
    gatewayCommandPrefix: [process.execPath, "--import", preload.href],
    startTimeoutMs: 120_000,
    env: {
      OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
      OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
      OPENCLAW_QA_CODEX_AUTH_APP_SERVER_MODELS: ACCOUNT_MODELS.join(","),
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
    config: {
      plugins: {
        enabled: true,
        allow: ["codex", "openai"],
        entries: {
          openai: { enabled: true },
          codex: {
            enabled: true,
            config: {
              appServer: {
                mode: "yolo",
                command: process.execPath,
                args: [appServerFixture, receiptClientUrl],
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          // No agentRuntime override: these turns take the default runtime.
          model: { primary: `openai/${DUAL_ROUTE_MODEL}`, fallbacks: [] },
          workspace: "~/workspace",
          skipBootstrap: true,
          timeoutSeconds: 60,
          sandbox: { mode: "off" },
        },
      },
    },
  });
  instance = gateway;
  const stopModelLists = modelLists.close;
  const cleanup = gateway.cleanup;
  gateway.cleanup = async () => {
    await cleanup();
    await stopModelLists();
  };

  const requestLog = gateway.state.path("codex-auth-app-server.jsonl");
  gateway.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
  const profiles: Record<string, Record<string, unknown>> = {};
  if (credentials !== "api-key") {
    profiles[OAUTH_PROFILE_ID] = {
      type: "oauth",
      provider: "openai",
      access: oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: ACCOUNT_ID,
    };
  }
  if (credentials !== "chatgpt") {
    profiles[API_KEY_PROFILE_ID] = { type: "api_key", provider: "openai", key: API_KEY };
  }
  // Like a fresh sign-in: stored profiles, no explicit auth order.
  await gateway.state.writeAuthProfiles({ version: 1, profiles });
  await gateway.startGateway();
  return {
    gateway,
    requestLog,
    appServerLog: createJsonlRequestTailer<AppServerLogEntry>(requestLog),
  };
}

async function runRouteTurns(params: {
  credentials: Credentials;
  models: readonly string[];
  expectedLogin: Record<string, unknown>;
}) {
  const { gateway, appServerLog } = await startRouteGateway(params.credentials);
  const client = await connectGatewayStatusClient(gateway);
  try {
    // The picker path publishes the account catalog; turns admit against what it showed.
    const listed = await client.request<{
      models?: Array<{ id?: string; provider?: string; available?: boolean }>;
    }>("models.list", { agentId: "main", refresh: true }, { timeoutMs: REQUEST_TIMEOUT_MS });
    for (const model of params.models) {
      expect(
        listed.models?.find((entry) => entry.provider === "openai" && entry.id === model),
        `${model} in models.list\n${JSON.stringify(listed.models)}`,
      ).toMatchObject({ available: true });
    }
    for (const model of params.models) {
      const sessionKey = `agent:main:qa-codex-account-route-${model}`;
      await client.request("sessions.patch", { key: sessionKey, model: `openai/${model}` });
      const turnsBefore = appServerLog.read().length;
      const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey,
        message: `Reply with ${PRODUCT_OUTPUT}.`,
        deliver: false,
        idempotencyKey: `qa-codex-account-route-${model}`,
      });
      expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
      const terminal = await client.request(
        "agent.wait",
        { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
        { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
      );
      const diagnostic = `${model}: ${JSON.stringify(terminal)}\n${gateway.logs()}`;
      expect(terminal, diagnostic).toMatchObject({ runId: started.runId, status: "ok" });
      const entries = appServerLog.read();
      expect(
        entries
          .slice(turnsBefore)
          .find(
            (entry) =>
              entry.method === "turn/start" &&
              JSON.stringify(entry.params).includes(`"model":"${model}"`),
          ),
        diagnostic,
      ).toBeDefined();
      const logins = entries.filter((entry) => entry.method === "account/login/start");
      expect(logins.length, diagnostic).toBeGreaterThan(0);
      for (const login of logins) {
        expect(login.params, diagnostic).toMatchObject(params.expectedLogin);
      }
    }
    const logs = gateway.logs();
    expect(logs).not.toContain("No route-compatible authentication source");
    expect(logs).not.toContain("requires an OpenAI API key profile");
  } finally {
    client.stop();
  }
}

describe("Codex account model route product proof", () => {
  it(
    "runs account-listed models on the default runtime with the only ChatGPT login",
    { timeout: 300_000 },
    async () => {
      await runRouteTurns({
        credentials: "chatgpt",
        models: [ACCOUNT_ONLY_MODEL, DAYBREAK_MODEL, DUAL_ROUTE_MODEL],
        expectedLogin: {
          type: "chatgptAuthTokens",
          accessToken: oauthAccess,
          chatgptAccountId: ACCOUNT_ID,
        },
      });
    },
  );

  it(
    "keeps the known dual-route model on ChatGPT when an API key is also stored",
    { timeout: 180_000 },
    async () => {
      await runRouteTurns({
        credentials: "chatgpt+api-key",
        models: [DUAL_ROUTE_MODEL],
        expectedLogin: { type: "chatgptAuthTokens", accessToken: oauthAccess },
      });
    },
  );

  it(
    "keeps API-key-only users on their key for the known dual-route model",
    { timeout: 180_000 },
    async () => {
      await runRouteTurns({
        credentials: "api-key",
        models: [DUAL_ROUTE_MODEL],
        expectedLogin: { type: "apiKey", apiKey: API_KEY },
      });
    },
  );
});
