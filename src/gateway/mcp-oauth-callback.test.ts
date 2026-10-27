import { beforeEach, expect, it, vi } from "vitest";
import { requesterMcpOAuthStoreKeyPrefix } from "../agents/mcp-oauth-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  readPending: vi.fn(),
  readStore: vi.fn(),
  context: { admission: { databasePath: "/synthetic/mcp/state.sqlite" } },
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  completeOAuthCallback: mocks.complete,
}));
vi.mock("../agents/mcp-oauth-store.js", () => ({
  readMcpOAuthPendingAuthorization: mocks.readPending,
  readMcpOAuthStore: mocks.readStore,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => mocks.context,
}));

import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";

const SERVER_URL = "https://calendar.example.com/mcp";
const STORE_KEY = `${requesterMcpOAuthStoreKeyPrefix("calendar", SERVER_URL)}fedcba9876543210`;
const AUTHORIZATION_URL =
  "https://accounts.example.com/authorize?state=state-1234567890&client_id=openclaw";
const server = {
  url: SERVER_URL,
  transport: "streamable-http",
  auth: "oauth",
  oauth: { identity: "per-requester" },
} as const;

function callbackConfig(serverName = "calendar"): OpenClawConfig {
  return { mcp: { servers: { [serverName]: server } } };
}

async function dispatch(
  path = "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
  options?: { config?: OpenClawConfig; method?: string },
) {
  const response = createResponse();
  const warn = vi.fn();
  const handled = await handleMcpOAuthCallback(
    createRequest({ path, method: options?.method }),
    response.res,
    { config: options?.config ?? callbackConfig(), log: { warn } },
  );
  return { handled, response, warn };
}

function expectPage(
  { handled, response }: Awaited<ReturnType<typeof dispatch>>,
  code = 404,
  text = "expired or was already used",
) {
  expect([handled, response.res.statusCode]).toEqual([true, code]);
  expect(response.getBody()).toContain(text);
}

beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue("authorized");
  mocks.readPending.mockReset().mockResolvedValue(STORE_KEY);
  mocks.readStore.mockReset().mockResolvedValue({ lastAuthorizationUrl: AUTHORIZATION_URL });
});

it("completes the requester row selected by exact OAuth state", async () => {
  const result = await dispatch(
    "/oauth/mcp/callback?code=authorization-code&state=state-1234567890&iss=https%3A%2F%2Faccounts.example.com%2Ftenant%2F",
  );

  expectPage(result, 200, "You&#39;re connected.");
  expect(result.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(mocks.readPending).toHaveBeenCalledWith("state-1234567890", mocks.context);
  expect(mocks.readStore).toHaveBeenCalledWith(STORE_KEY, mocks.context);
  expect(mocks.complete).toHaveBeenCalledWith(
    {
      storeKey: STORE_KEY,
      principal: "requester",
      serverName: "calendar",
      serverUrl: SERVER_URL,
    },
    expect.objectContaining({ kind: "http", url: SERVER_URL }),
    {
      code: "authorization-code",
      state: "state-1234567890",
      iss: "https://accounts.example.com/tenant/",
    },
    undefined,
    mocks.context,
  );
});

it("rejects ambiguous issuer parameters without consuming authorization", async () => {
  const result = await dispatch(
    "/oauth/mcp/callback?code=authorization-code&state=state-1234567890&iss=https%3A%2F%2Faccounts.example.com&iss=https%3A%2F%2Fother.example",
  );
  expectPage(result, 400, "Ask the bot to connect again.");
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("rejects unknown and replayed states with the same generic page", async () => {
  mocks.readPending.mockResolvedValue(undefined);

  const unknown = await dispatch("/oauth/mcp/callback?code=authorization-code&state=unknown-state");
  const replay = await dispatch();

  for (const result of [unknown, replay]) {
    expectPage(result);
  }
  expect(mocks.readStore).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it.each(["consumed", "replaced", "renamed"])("rejects %s OAuth ownership", async (ownership) => {
  if (ownership === "consumed") {
    mocks.complete.mockResolvedValue("expired");
  } else if (ownership === "replaced") {
    mocks.readStore.mockResolvedValue({
      lastAuthorizationUrl: "https://example.com/?state=replaced",
    });
  }
  const config = callbackConfig(ownership === "renamed" ? "renamed" : "calendar");
  expectPage(await dispatch(undefined, { config }));
  if (ownership !== "consumed") {
    expect(mocks.complete).not.toHaveBeenCalled();
  }
});

it.each(["provider", "exchange"])("does not expose %s failures", async (source) => {
  const provider = source === "provider";
  if (!provider) {
    mocks.complete.mockRejectedValue(new Error("invalid_grant for secret-code"));
  }
  const query = provider ? "error=access_denied&error_description=nope" : "code=wrong-code";
  const result = await dispatch(`/oauth/mcp/callback?${query}&state=state-1234567890`);
  expectPage(result, 400, "Ask the bot to connect again.");
  if (provider) {
    expect(result.response.getBody()).not.toContain("nope");
    expect(mocks.complete).not.toHaveBeenCalled();
  } else {
    expect(result.response.getBody()).not.toMatch(/invalid_grant|wrong-code/);
    expect(result.warn).toHaveBeenCalledOnce();
  }
});

it("leaves other methods and paths unclaimed", async () => {
  const wrongMethod = await dispatch(undefined, { method: "POST" });
  const wrongPath = await dispatch("/oauth/other?code=authorization-code&state=state-1234567890");

  expect([wrongMethod, wrongPath]).toMatchObject([{ handled: false }, { handled: false }]);
  expect(mocks.readPending).not.toHaveBeenCalled();
});

it("bounds the callback query before reading durable state", async () => {
  const result = await dispatch(
    `/oauth/mcp/callback?code=${"x".repeat(8 * 1024)}&state=state-1234567890`,
  );

  expectPage(result, 400, "Ask the bot to connect again.");
  expect(mocks.readPending).not.toHaveBeenCalled();
  expect(mocks.readStore).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});
