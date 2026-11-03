// QA Lab Codex auth product proof exercises doctor, SQLite, Gateway, and app-server together.
import fs from "node:fs/promises";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../../../../src/cron/store.js";
import type { CronStoredJob } from "../../../../src/cron/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../../src/test-utils/session-state-cleanup.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import type { FixtureReceiptChannel } from "../../../helpers/fixture-receipts.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { connectGatewayStatusClient, postJson } from "../../../helpers/gateway-e2e-harness.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";
import {
  createCodexProductInstance,
  createCodexReceiptClient,
} from "./codex-product.test-support.js";

const oauthAccess = "test-oauth-access";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
const MISSING_PROFILE_ID = "openai:missing";
const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT =
  "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const REQUEST_TIMEOUT_MS = 60_000;
const EXPECTED_LOGIN = {
  type: "chatgptAuthTokens",
  accessToken: oauthAccess,
  chatgptAccountId: ACCOUNT_ID,
  chatgptPlanType: null,
};

let instance: OpenClawTestInstance | undefined;
let receipts: FixtureReceiptChannel;
let receiptClientUrl: string;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

beforeAll(async () => {
  ({ receipts, receiptClientUrl } = await createCodexReceiptClient(
    tempDirs.make("codex-auth-receipts-"),
  ));
});

afterAll(async () => {
  await receipts?.close();
});

type AppServerLogEntry = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

type GatewayHistory = Record<string, unknown> & {
  messages?: unknown[];
  sessionInfo?: { lastRunError?: unknown };
};

type GatewayEvent = { event?: string; payload?: unknown };

function expectRequestOrder(entries: AppServerLogEntry[], first: string, second: string) {
  const firstIndex = entries.findIndex((entry) => entry.method === first);
  const secondIndex = entries.findIndex((entry) => entry.method === second);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
  return [entries[firstIndex], entries[secondIndex]];
}

function expectBoundedMissingProfileRecovery(
  value: unknown,
  options?: { sessionError?: boolean; diagnostic?: string },
) {
  const serialized = JSON.stringify(value);
  if (options?.sessionError) {
    expect(typeof value).toBe("string");
    expect(value).toBe(SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT);
    expect(String(value).length).toBeLessThanOrEqual(160);
  } else {
    expect(serialized, options?.diagnostic).toContain(SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT);
  }
  expect(serialized).not.toContain(MISSING_PROFILE_ID);
  expect(serialized).not.toContain("was not found");
  expect(serialized).not.toContain("Codex app-server auth profile");
  expect(serialized).not.toContain("/login codex");
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

async function waitForRequest(
  requestLog: { read(): AppServerLogEntry[] },
  source: string,
  method: string,
  signal: AbortSignal,
) {
  // The transport records requests before their handlers report or reply; late receipts are safe.
  if (!requestLog.read().some((entry) => entry.method === method)) {
    await withinTest(receipts.waitFor(source, method), signal);
  }
  const entries = requestLog.read();
  const request = entries.find((entry) => entry.method === method);
  if (!request) {
    const observedMethods = entries.flatMap((entry) =>
      typeof entry.method === "string" ? [entry.method] : [],
    );
    throw new Error(
      `waiting for Codex app-server method ${method}; observed ${observedMethods.join(", ") || "no methods"}`,
    );
  }
  return request;
}

function chatgptAccessToken(accountId: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function waitForAssistantHistory(testInstance: OpenClawTestInstance, expected: string) {
  const client = await connectGatewayStatusClient(testInstance);
  try {
    return await vi.waitFor(
      async () => {
        const result = await client.request<{
          sessions?: Array<{ key?: unknown }>;
        }>("sessions.list", { limit: 20 });
        const sessionKeys = (result.sessions ?? []).flatMap((session) =>
          typeof session.key === "string" ? [session.key] : [],
        );
        const histories = await Promise.allSettled(
          sessionKeys.map(async (sessionKey) => ({
            history: await client.request<GatewayHistory>(
              "chat.history",
              { agentId: "main", sessionKey, limit: 50 },
              { timeoutMs: 5_000 },
            ),
            sessionKey,
          })),
        );
        for (const entry of histories) {
          if (entry.status === "fulfilled") {
            const { history, sessionKey } = entry.value;
            const messages = Array.isArray(history.messages) ? history.messages : [];
            if (
              messages.some(
                (message) =>
                  isRecord(message) &&
                  message.role === "assistant" &&
                  JSON.stringify(message).includes(expected),
              )
            ) {
              return { history, sessionKey };
            }
          }
        }
        const failed = histories.filter((entry) => entry.status === "rejected").length;
        throw new Error(
          `waiting for assistant history text ${expected}; ${failed}/${sessionKeys.length} history reads failed`,
        );
      },
      { interval: 100, timeout: REQUEST_TIMEOUT_MS },
    );
  } finally {
    client.stop();
  }
}

async function connectGatewayEventClient(
  testInstance: OpenClawTestInstance,
  events: GatewayEvent[],
) {
  return acquireGatewayTestClient(
    {
      url: `ws://127.0.0.1:${testInstance.port}`,
      origin: `http://127.0.0.1:${testInstance.port}`,
      token: testInstance.gatewayToken,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      clientDisplayName: "Codex missing auth profile QA",
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

async function createAuthGateway(missingProfile = false) {
  return createCodexProductInstance({
    name: missingProfile ? "qa-codex-missing-auth-profile" : "qa-codex-auth-product-proof",
    receiptClientUrl,
    model: missingProfile ? `${MODEL}@${MISSING_PROFILE_ID}` : MODEL,
    nativeModel: MODEL,
    logging: missingProfile ? { consoleLevel: "debug" } : undefined,
    env: missingProfile
      ? { OPENCLAW_LOG_LEVEL: undefined, VITEST: undefined, NODE_ENV: undefined }
      : undefined,
  });
}

describe("Codex auth product proof", () => {
  it(
    "runs migrated heartbeat-main on explicit Codex after doctor --fix twice",
    { timeout: 240_000 },
    async ({ signal }) => {
      instance = await createAuthGateway();
      instance.env.OPENCLAW_SKIP_CRON = "0";
      const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
      await instance.state.writeConfig({
        ...config,
        agents: {
          ...config.agents,
          entries: {
            main: { agentDir: instance.state.agentDir(), workspace: instance.state.workspaceDir },
          },
          defaults: {
            ...config.agents?.defaults,
            systemAgent: { agentId: "main" },
          },
        },
      });
      const requestLog = instance.state.path("codex-heartbeat-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      const createdAtMs = Date.now();
      const job: CronStoredJob = {
        id: "migrated-heartbeat-main",
        name: "heartbeat-main",
        agentId: "main",
        enabled: true,
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: createdAtMs },
        sessionKey: "agent:main:main",
        sessionTarget: "session:agent:main:main",
        wakeMode: "now",
        idleOnly: true,
        payload: {
          kind: "agentTurn",
          message: `Reply with ${PRODUCT_OUTPUT}.`,
          skipIfScratchEmpty: true,
        },
        delivery: { mode: "none", target: "owner" },
        state: {},
      };
      // Preserve the existing post-migration job, including its name and absent account binding.
      const testInstance = instance;
      await withEnvAsync(instance.env, async () => {
        await saveCronJobsStore(resolveCronJobsStorePathFromConfig(config, testInstance.env), {
          version: 1,
          jobs: [job],
        });
        await cleanupSessionStateForTest({
          stateDir: testInstance.stateDir,
          rootPath: testInstance.state.root,
        });
      });
      // The first Doctor migrates the stable credential and adopts the automation's account.
      await runCodexAuthDoctorMigrationProof(instance, {
        accountId: ACCOUNT_ID,
        oauthAccess,
        shape: "oauth-only",
      });
      const repeated = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
        timeoutMs: 120_000,
      });
      expect(repeated.code, repeated.stderr).toBe(0);
      await instance.startGateway();
      const client = await connectGatewayStatusClient(instance);
      try {
        const { jobs } = await client.request<{ jobs: CronStoredJob[] }>("cron.list", {
          includeDisabled: true,
        });
        const heartbeat = jobs.find((entry) => entry.id === job.id);
        expect(heartbeat).toMatchObject({
          payload: { kind: "agentTurn" },
          sessionTarget: "session:agent:main:main",
          delivery: { target: "owner" },
        });
        if (!heartbeat) {
          throw new Error("Doctor did not migrate heartbeat-main");
        }
        const scratch = await client.request<{ currentRevision: number }>("cron.scratch.get", {
          id: heartbeat.id,
        });
        await client.request("cron.scratch.set", {
          id: heartbeat.id,
          content: "Synthetic heartbeat work.",
          expectedRevision: scratch.currentRevision,
        });
        const started = await client.request<{ runId: string }>("cron.run", {
          id: heartbeat.id,
          mode: "force",
        });
        const terminal = await vi.waitFor(
          async () => {
            const history = await client.request<{
              entries: Array<{ runId?: string; status?: string; error?: string }>;
            }>("cron.runs", { id: heartbeat.id, runId: started.runId, limit: 1 });
            const entry = history.entries.find((candidate) => candidate.runId === started.runId);
            if (!entry) {
              throw new Error("Waiting for the heartbeat run to finish");
            }
            return entry;
          },
          { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
        );
        expect(terminal).toMatchObject({ status: "ok" });
        const login = await waitForRequest(appServerLog, requestLog, "account/login/start", signal);
        expect(login.params).toMatchObject(EXPECTED_LOGIN);
        expectRequestOrder(appServerLog.read(), "account/login/start", "turn/start");
        await waitForAssistantHistory(instance, PRODUCT_OUTPUT);
      } finally {
        client.stop();
      }
    },
  );

  it(
    "repairs mixed legacy auth into SQLite and sends the selected OAuth profile to app-server",
    { timeout: 180_000 },
    async ({ signal }) => {
      instance = await createAuthGateway();

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      await runCodexAuthDoctorMigrationProof(instance, {
        accountId: ACCOUNT_ID,
        oauthAccess,
        shape: "mixed",
      });

      await instance.startGateway();
      const hook = await postJson(
        `http://127.0.0.1:${instance.port}/hooks/agent`,
        {
          message: `Reply with ${PRODUCT_OUTPUT}.`,
          name: "Codex auth product proof",
          deliver: false,
        },
        { Authorization: `Bearer ${instance.hookToken}` },
      );
      expect(hook.status, JSON.stringify(hook.json)).toBe(200);

      const loginRequest = await waitForRequest(
        appServerLog,
        requestLog,
        "account/login/start",
        signal,
      );
      expect(loginRequest.params).toMatchObject(EXPECTED_LOGIN);

      await waitForRequest(appServerLog, requestLog, "turn/start", signal);
      expectRequestOrder(appServerLog.read(), "thread/start", "turn/start");
      await waitForAssistantHistory(instance, PRODUCT_OUTPUT);

      const usageRequestLog = instance.state.path("codex-auth-usage-app-server.jsonl");
      const usageLog = createJsonlRequestTailer<AppServerLogEntry>(usageRequestLog);
      // The running Gateway keeps its original log, including background catalog reads.
      const cliEnv = instance.env;
      cliEnv.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = usageRequestLog;
      const status = await instance
        .cli(["status", "--usage", "--json", "--timeout", "60000"], {
          timeoutMs: 120_000,
        })
        .finally(() => {
          cliEnv.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
        });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("qa-codex-account@example.com");

      const usageEntries = usageLog.read();
      const [usageLoginRequest, accountReadRequest] = expectRequestOrder(
        usageEntries,
        "account/login/start",
        "account/read",
      );
      expect(usageLoginRequest?.params).toEqual(EXPECTED_LOGIN);
      expect(accountReadRequest?.params).toEqual({});
    },
  );

  it(
    "returns bounded recovery after the explicitly selected profile is removed",
    { timeout: 180_000 },
    async () => {
      instance = await createAuthGateway(true);

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: {
          [MISSING_PROFILE_ID]: {
            type: "token",
            provider: "openai",
            token: chatgptAccessToken(ACCOUNT_ID),
            accountId: ACCOUNT_ID,
          },
        },
      });

      await instance.startGateway();
      const sessionKey = "agent:main:qa-codex-missing-auth-profile";
      const events: GatewayEvent[] = [];
      const client = await connectGatewayEventClient(instance, events);
      let runId = "";
      let terminal: unknown;
      let failedHistory: GatewayHistory | undefined;
      let finalEvent: GatewayEvent | undefined;
      let lifecycleEvent: GatewayEvent | undefined;
      try {
        const testInstance = instance;
        const runConfiguredTurn = async (idempotencyKey: string) => {
          const setup = await client.request<{ runId?: string; status?: string }>("chat.send", {
            sessionKey,
            message: `Reply with ${PRODUCT_OUTPUT}.`,
            deliver: false,
            idempotencyKey,
          });
          expect(setup).toMatchObject({ runId: expect.any(String), status: "started" });
          const setupTerminal = await client.request(
            "agent.wait",
            { runId: setup.runId, timeoutMs: REQUEST_TIMEOUT_MS },
            { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
          );
          expect(
            setupTerminal,
            `${JSON.stringify(setupTerminal)}\n${JSON.stringify(appServerLog.read())}\n${testInstance.logs()}`,
          ).toMatchObject({ runId: setup.runId, status: "ok" });
        };
        await runConfiguredTurn("qa-codex-profile-binding-setup");
        await expect(
          client.request("models.list", { agentId: "main", refresh: true }),
        ).resolves.toMatchObject({
          models: expect.arrayContaining([
            expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai" }),
          ]),
        });
        await expect(
          client.request("sessions.patch", {
            key: sessionKey,
            model: `${MODEL}@${MISSING_PROFILE_ID}`,
          }),
        ).resolves.toMatchObject({
          ok: true,
          entry: {
            authProfileOverride: MISSING_PROFILE_ID,
            authProfileOverrideSource: "user",
          },
        });
        // A metadata patch alone does not prove the selected profile reaches native execution.
        await runConfiguredTurn("qa-codex-profile-binding-pinned");

        const logoutResult = await client.request("models.authLogout", {
          provider: "openai",
          agentId: "main",
          profileIds: [MISSING_PROFILE_ID],
        });
        expect(logoutResult, testInstance.logs()).toEqual({
          provider: "openai",
          removedProfiles: [MISSING_PROFILE_ID],
          abortedRunIds: [],
        });
        await fs.writeFile(requestLog, "", "utf8");
        events.length = 0;
        await client.request("sessions.messages.subscribe", { key: sessionKey });
        await client.request("sessions.subscribe", {});
        const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: "Prove missing selected auth profile recovery.",
          deliver: false,
          idempotencyKey: "qa-codex-missing-auth-profile",
        });
        expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
        runId = started.runId ?? "";
        terminal = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(terminal).toMatchObject({ runId, status: "error" });
        await vi.waitFor(
          () => {
            finalEvent = events.find(
              (event) =>
                event.event === "chat" &&
                isRecord(event.payload) &&
                event.payload.runId === runId &&
                event.payload.state === "error",
            );
            lifecycleEvent = events.find(
              (event) =>
                event.event === "sessions.changed" &&
                isRecord(event.payload) &&
                event.payload.sessionKey === sessionKey &&
                isRecord(event.payload.session) &&
                event.payload.session.lastRunId === runId &&
                event.payload.session.status === "failed",
            );
            expect(finalEvent).toBeDefined();
            expect(lifecycleEvent).toBeDefined();
          },
          { interval: 20, timeout: 5_000 },
        );

        failedHistory = await client.request<GatewayHistory>(
          "chat.history",
          { agentId: "main", sessionKey, limit: 50 },
          { timeoutMs: 5_000 },
        );
      } finally {
        client.stop();
      }

      const failureAppServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);

      expectBoundedMissingProfileRecovery(finalEvent?.payload, { diagnostic: instance.logs() });
      // Lifecycle metadata belongs to sessions.changed; transcript delivery has independent timing.
      expectBoundedMissingProfileRecovery(
        (lifecycleEvent?.payload as { session?: { lastRunError?: unknown } } | undefined)?.session
          ?.lastRunError,
        { sessionError: true },
      );
      expectBoundedMissingProfileRecovery(terminal);
      expectBoundedMissingProfileRecovery(failedHistory?.sessionInfo?.lastRunError, {
        sessionError: true,
      });
      expect(JSON.stringify(failedHistory)).not.toContain(MISSING_PROFILE_ID);
      expect(JSON.stringify(failedHistory)).not.toContain("Codex app-server auth profile");

      const failureMethods = failureAppServerLog
        .read()
        .flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
      const operationalMethods = failureMethods.filter(
        (method) => method !== "initialize" && method !== "initialized",
      );
      // App-server may perform read-only capability discovery before OpenClaw rejects the
      // removed profile, but it must not start or resume a conversation turn.
      expect(
        operationalMethods.filter((method) => method !== "model/list" && method !== "account/read"),
      ).toEqual([]);
    },
  );
});
