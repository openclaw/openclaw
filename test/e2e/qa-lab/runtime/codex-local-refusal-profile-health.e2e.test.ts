// Product path proof: a host-owned Codex authority refusal must stay inside its own run.
// The shared OAuth profile keeps serving, so the next sibling turn answers normally instead
// of reporting the credential as temporarily unavailable.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import type { FixtureReceiptChannel } from "../../../helpers/fixture-receipts.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  createCodexProductInstance,
  createCodexReceiptClient,
} from "./codex-product.test-support.js";

const PROFILE_ID = "openai:qa-shared-refusal";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const LOCAL_REFUSAL_USER_COPY = "refused before it reached the AI service";
const PROFILE_UNAVAILABLE_COPY = "is temporarily unavailable";
const RE_LOGIN_ADVICE_MARKERS = [
  "/login",
  "Choose another login",
  "isn't accepting your saved login",
];
const REQUEST_TIMEOUT_MS = 60_000;

const chatgptAccessToken = (accountId: string): string =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");

let instance: OpenClawTestInstance | undefined;
let receipts: FixtureReceiptChannel;
let receiptClientUrl: string;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

beforeAll(async () => {
  ({ receipts, receiptClientUrl } = await createCodexReceiptClient(
    tempDirs.make("codex-refusal-receipts-"),
  ));
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

afterAll(async () => {
  await receipts?.close();
});

type GatewayHistory = Record<string, unknown> & {
  messages?: unknown[];
  sessionInfo?: { lastRunError?: { reason?: unknown } };
};

type ModelAuthStatusResult = {
  providers?: Array<{
    provider?: string;
    profiles?: Array<{
      profileId?: string;
      status?: string;
      reasonCode?: string;
      source?: string;
    }>;
  }>;
};

async function connectRunClient(testInstance: OpenClawTestInstance, events: unknown[]) {
  return acquireGatewayTestClient(
    {
      url: `ws://127.0.0.1:${testInstance.port}`,
      origin: `http://127.0.0.1:${testInstance.port}`,
      token: testInstance.gatewayToken,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      clientDisplayName: "Codex local refusal profile health QA",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      platform: "qa",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: (event) => events.push(event),
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMessage: `Gateway client connection timed out:\n${testInstance.logs()}`,
      closeMessage: "Gateway closed",
      unrefTimeout: true,
    },
  );
}

async function runTurn(
  client: Awaited<ReturnType<typeof connectRunClient>>,
  sessionKey: string,
  idempotencyKey: string,
) {
  const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey,
    message: `Reply with ${PRODUCT_OUTPUT}.`,
    deliver: false,
    idempotencyKey,
  });
  expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
  const terminal = await client.request<Record<string, unknown>>(
    "agent.wait",
    { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
    { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
  );
  // One paired client for the whole flow: a second device identity needs re-approval.
  const history = await client.request<GatewayHistory>(
    "chat.history",
    { agentId: "main", sessionKey, limit: 50 },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  return { terminal, history };
}

async function readOpenaiAuthHealth(client: Awaited<ReturnType<typeof connectRunClient>>) {
  const result = await client.request<ModelAuthStatusResult>(
    "models.authStatus",
    { agentId: "main" },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  return (result.providers ?? []).find((provider) => provider.provider === "openai");
}

describe("codex local authority refusal product path", () => {
  it(
    "keeps the shared profile serving so the next sibling turn answers after a refusal",
    { timeout: 240_000 },
    async () => {
      instance = await createCodexProductInstance({
        name: "qa-codex-local-refusal",
        receiptClientUrl,
        model: MODEL,
        nativeModel: MODEL,
      });
      const requestLog = instance.state.path("codex-refusal-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      // Refuse only the first turn; the sibling turn is the subject of the proof.
      instance.env.OPENCLAW_QA_CODEX_REFUSED_TURNS = "1";
      const appServerLog = createJsonlRequestTailer<{ method?: string }>(requestLog);
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: {
          [PROFILE_ID]: {
            type: "token",
            provider: "openai",
            token: chatgptAccessToken(ACCOUNT_ID),
            accountId: ACCOUNT_ID,
          },
        },
      });

      await instance.startGateway();
      const testInstance = instance;
      const sessionKey = "agent:main:qa-codex-local-refusal";
      const events: unknown[] = [];
      const client = await connectRunClient(testInstance, events);

      try {
        const refused = await runTurn(client, sessionKey, "qa-codex-refused-run");
        const refusedSerialized = JSON.stringify({
          terminal: refused.terminal,
          history: refused.history,
        });
        const refusalDiagnosis = `${refusedSerialized}\n${JSON.stringify(
          appServerLog.read(),
        )}\n${testInstance.logs()}`;
        expect(refused.terminal, refusalDiagnosis).toMatchObject({ status: "error" });
        // The run surfaces as a local refusal: it names the next step and never claims the
        // credential failed, so the shared profile stays usable.
        expect(refused.terminal.error, refusalDiagnosis).toContain(LOCAL_REFUSAL_USER_COPY);
        expect(refusedSerialized, refusalDiagnosis).not.toContain(PROFILE_UNAVAILABLE_COPY);
        for (const reLoginAdvice of RE_LOGIN_ADVICE_MARKERS) {
          expect(refusedSerialized, refusalDiagnosis).not.toContain(reLoginAdvice);
        }

        const sibling = await runTurn(client, sessionKey, "qa-codex-sibling-run");
        const siblingSerialized = JSON.stringify({
          terminal: sibling.terminal,
          history: sibling.history,
        });
        expect(sibling.terminal, `${siblingSerialized}\n${testInstance.logs()}`).toMatchObject({
          status: "ok",
        });
        expect(siblingSerialized).toContain(PRODUCT_OUTPUT);
        expect(siblingSerialized).not.toContain(PROFILE_UNAVAILABLE_COPY);

        expect(appServerLog.read().filter((entry) => entry.method === "turn/start")).toHaveLength(
          2,
        );
        const openaiHealth = await readOpenaiAuthHealth(client);
        const sharedProfile = (openaiHealth?.profiles ?? []).find(
          (profile) => profile.profileId === PROFILE_ID,
        );
        // Still a saved, usable credential: "static" is a healthy token with no expiry to
        // check, while a cooled profile surfaces as unavailable on the next selection.
        expect(sharedProfile?.source, JSON.stringify(openaiHealth)).toBe("saved");
        expect(["ok", "static"], JSON.stringify(openaiHealth)).toContain(sharedProfile?.status);
      } finally {
        client.stop();
      }
    },
  );
});
