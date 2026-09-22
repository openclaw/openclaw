// QA Lab Codex auth product proof exercises doctor, SQLite, Gateway, and app-server together.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../../src/config/sessions/session-accessor.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { connectGatewayStatusClient, postJson } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import {
  findCodexFixtureTurnAccountEvidence,
  runCodexAuthDoctorMigrationProof,
} from "./codex-auth-product-proof.test-support.js";

const oauthAccess = "test-oauth-access";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
const MISSING_PROFILE_ID = "openai:missing";
const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT =
  "The selected auth profile is unavailable in this agent's OpenClaw credential store. " +
  "Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const REQUEST_TIMEOUT_MS = 60_000;

let instance: OpenClawTestInstance | undefined;

type AppServerLogEntry = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  fixtureAuthOperation?: unknown;
};

type AppServerRequestLog = { read(): AppServerLogEntry[] };

type GatewayHistory = Record<string, unknown> & {
  messages?: unknown[];
  sessionInfo?: { lastRunError?: unknown };
};

type GatewayEvent = { event?: string; payload?: unknown };
type CodexLifecyclePayload = {
  runId?: unknown;
  sessionKey?: unknown;
  stream?: unknown;
  data?: { phase?: unknown; threadId?: unknown; clientId?: unknown };
};

function expectBoundedMissingProfileRecovery(
  value: unknown,
  options?: { allowSessionTruncation?: boolean },
) {
  const serialized = JSON.stringify(value);
  if (options?.allowSessionTruncation) {
    expect(typeof value).toBe("string");
    expect(value).toContain("The selected auth profile is unavailable");
    expect(value).toContain("`openclaw configure`");
    expect(value).toMatch(/then retry\.$/u);
    expect(value).toHaveLength(160);
  } else {
    expect(serialized).toContain(SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT);
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

function waitForRequest(requestLog: AppServerRequestLog, method: string) {
  return vi.waitFor(
    () => {
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
    },
    { interval: 25, timeout: REQUEST_TIMEOUT_MS },
  );
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
                  message !== null &&
                  typeof message === "object" &&
                  (message as { role?: unknown }).role === "assistant" &&
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
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
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
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out:\n${testInstance.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

describe("Codex auth product proof", () => {
  it(
    "repairs mixed legacy auth into SQLite and sends the selected OAuth profile to app-server",
    { timeout: 180_000 },
    async () => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const appServerFixture = fileURLToPath(
        new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-auth-product-proof",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [appServerFixture],
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: MODEL, fallbacks: [] },
              models: { [MODEL]: { agentRuntime: { id: "codex" } } },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      const canonicalStore = await runCodexAuthDoctorMigrationProof(instance, {
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

      const loginRequest = await waitForRequest(appServerLog, "account/login/start");
      const loginParams = loginRequest.params as Record<string, unknown>;
      expect(loginParams.type).toBe("chatgptAuthTokens");
      expect(loginParams.accessToken === oauthAccess).toBe(true);
      expect(loginParams.chatgptAccountId).toBe(ACCOUNT_ID);
      expect(loginParams.chatgptPlanType).toBeNull();

      await waitForRequest(appServerLog, "turn/start");
      const turnEntries = appServerLog.read();
      const threadStartIndex = turnEntries.findIndex(
        (request) => request.method === "thread/start",
      );
      const turnStartIndex = turnEntries.findIndex((request) => request.method === "turn/start");
      expect(threadStartIndex).toBeGreaterThanOrEqual(0);
      expect(turnStartIndex).toBeGreaterThan(threadStartIndex);
      const completedTurn = await waitForAssistantHistory(instance, PRODUCT_OUTPUT);

      const beforeUsage = appServerLog.read().length;
      const status = await instance.cli(["status", "--usage", "--json", "--timeout", "60000"], {
        timeoutMs: 120_000,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("qa-codex-account@example.com");

      const usageEntries = appServerLog.read().slice(beforeUsage);
      const usageLoginIndex = usageEntries.findIndex(
        (request) => request.method === "account/login/start",
      );
      const accountReadIndex = usageEntries.findIndex(
        (request) => request.method === "account/read",
      );
      expect(usageLoginIndex).toBeGreaterThanOrEqual(0);
      expect(accountReadIndex).toBeGreaterThan(usageLoginIndex);

      const usageLoginRequest = usageEntries[usageLoginIndex];
      const usageLoginParams = usageLoginRequest?.params as Record<string, unknown>;
      expect(usageLoginParams).toEqual({
        type: "chatgptAuthTokens",
        accessToken: oauthAccess,
        chatgptAccountId: ACCOUNT_ID,
        chatgptPlanType: null,
      });

      const accountReadRequest = usageEntries[accountReadIndex];
      expect(accountReadRequest?.params).toEqual({});
      const accountReadResponse = usageEntries.find(
        (entry) => entry.id === accountReadRequest?.id && entry.result !== undefined,
      );
      expect(accountReadResponse?.result).toEqual({
        account: {
          type: "chatgpt",
          email: "qa-codex-account@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      });

      console.log(
        `[qa-codex-auth-product-proof] ${JSON.stringify({
          selectedProfileId: canonicalStore?.order?.openai?.[0],
          canonicalStore: {
            profileIds: Object.keys(canonicalStore?.profiles ?? {}).toSorted(),
            order: canonicalStore?.order?.openai,
            legacyJsonRemoved: true,
          },
          gatewayTurn: {
            threadStartOrder: threadStartIndex,
            turnStartOrder: turnStartIndex,
            assistantOutput: PRODUCT_OUTPUT,
            historySessionKey: completedTurn.sessionKey,
            historySessionId: completedTurn.history.sessionId,
          },
          appServer: [
            {
              order: usageLoginIndex,
              method: usageLoginRequest?.method,
              params: {
                type: usageLoginParams.type,
                accessToken: "redacted",
                chatgptAccountId: usageLoginParams.chatgptAccountId,
                chatgptPlanType: usageLoginParams.chatgptPlanType,
              },
            },
            {
              order: accountReadIndex,
              method: accountReadRequest?.method,
              params: accountReadRequest?.params,
              result: accountReadResponse?.result,
            },
          ],
        })}`,
      );
    },
  );

  it.each([
    {
      name: "the configured account",
      configuredProfileId: MISSING_PROFILE_ID,
      configuredAccountId: ACCOUNT_ID,
    },
    {
      name: "a distinct selected account",
      configuredProfileId: "openai:configured",
      configuredAccountId: "qa-codex-configured-account",
    },
  ])(
    "returns bounded recovery after removing $name",
    { timeout: 180_000 },
    async ({ configuredProfileId, configuredAccountId }) => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const appServerFixture = fileURLToPath(
        new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-missing-auth-profile",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          // Auth refresh consumes the configured owner published by full Gateway startup.
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [appServerFixture],
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: `${MODEL}@${configuredProfileId}`, fallbacks: [] },
              models: { [MODEL]: { agentRuntime: { id: "codex" } } },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: {
          [configuredProfileId]: {
            type: "token",
            provider: "openai",
            token: chatgptAccessToken(configuredAccountId),
          },
          [MISSING_PROFILE_ID]: {
            type: "token",
            provider: "openai",
            token: chatgptAccessToken(ACCOUNT_ID),
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
      try {
        const testInstance = instance;
        const nativeLifecycleForRun = (targetRunId: string) =>
          events.filter((event) => {
            const payload = event.payload as CodexLifecyclePayload | undefined;
            // A misrouted or unlabelled frame must not hide native work for this run.
            return (
              payload?.runId === targetRunId && payload.stream === "codex_app_server.lifecycle"
            );
          });
        const runConfiguredTurn = async (
          idempotencyKey: string,
          targetSessionKey = sessionKey,
          expectedAccountId?: string,
        ) => {
          let setupRunId = "";
          let controlFailed = false;
          let captureFailure: { error: unknown } | undefined;
          let controlCursor: { index: number; prefix: string } | undefined;
          let controlProof: unknown;
          try {
            const controlStartEntries = appServerLog.read();
            const controlStartIndex = controlStartEntries.length;
            const controlStartPrefix = JSON.stringify(controlStartEntries);
            controlCursor = { index: controlStartIndex, prefix: controlStartPrefix };
            if (expectedAccountId !== undefined) {
              expect(controlStartIndex, "app-server history reached the tailer cap").toBeLessThan(
                1024,
              );
              expect(
                (await fs.stat(requestLog)).size,
                "app-server log reached the read cap",
              ).toBeLessThan(2 * 1024 * 1024);
            }
            const setup = await client.request<{ runId?: string; status?: string }>("chat.send", {
              sessionKey: targetSessionKey,
              message: `Reply with ${PRODUCT_OUTPUT}.`,
              deliver: false,
              idempotencyKey,
            });
            expect(setup).toMatchObject({ runId: expect.any(String), status: "started" });
            setupRunId = setup.runId ?? "";
            expect(setupRunId).toMatch(/\S/);
            const setupTerminal = await client.request(
              "agent.wait",
              { runId: setup.runId, timeoutMs: REQUEST_TIMEOUT_MS },
              { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
            );
            expect(
              setupTerminal,
              `${JSON.stringify(setupTerminal)}\n${JSON.stringify(appServerLog.read())}\n${testInstance.logs()}`,
            ).toMatchObject({ runId: setup.runId, status: "ok" });
            if (expectedAccountId !== undefined) {
              const proof = await vi.waitFor(
                () => {
                  const matching = nativeLifecycleForRun(setupRunId)
                    .filter(
                      (event) =>
                        event.event === "agent" &&
                        (event.payload as CodexLifecyclePayload).sessionKey === targetSessionKey,
                    )
                    .map((event) => event.payload as CodexLifecyclePayload);
                  const startup = matching.findIndex(
                    (payload) => payload.data?.phase === "startup",
                  );
                  const ready = matching.findIndex(
                    (payload, index) => index > startup && payload.data?.phase === "thread_ready",
                  );
                  expect(startup).toBeGreaterThanOrEqual(0);
                  expect(ready).toBeGreaterThan(startup);
                  expect(matching[ready]?.data).toMatchObject({
                    threadId: expect.stringMatching(/\S/),
                    clientId: expect.stringMatching(/\S/),
                  });
                  const entries = appServerLog.read();
                  expect(entries.length, "app-server history reached the tailer cap").toBeLessThan(
                    1024,
                  );
                  expect(entries.length).toBeGreaterThanOrEqual(controlStartIndex);
                  expect(
                    JSON.stringify(entries.slice(0, controlStartIndex)) === controlStartPrefix,
                    "app-server history changed before the control cursor",
                  ).toBe(true);
                  const threadId = matching[ready]?.data?.threadId;
                  const accountEvidence = findCodexFixtureTurnAccountEvidence(entries, {
                    afterIndex: controlStartIndex,
                    threadId: typeof threadId === "string" ? threadId : "",
                    accountId: expectedAccountId,
                  });
                  expect(
                    accountEvidence,
                    "missing unique completed native turn with the selected account",
                  ).toBeDefined();
                  return structuredClone({
                    lifecycle: [matching[startup], matching[ready]],
                    accountEvidence,
                  });
                },
                { interval: 25, timeout: REQUEST_TIMEOUT_MS },
              );
              controlProof = proof;
              expect(
                (await fs.stat(requestLog)).size,
                "app-server log reached the read cap",
              ).toBeLessThan(2 * 1024 * 1024);
            }
          } catch (error) {
            controlFailed = true;
            throw error;
          } finally {
            if (expectedAccountId !== undefined) {
              let correlationDiagnostic: unknown = { status: "capture-not-complete" };
              try {
                const entries = appServerLog.read();
                const diagnosticStart = Math.max(0, entries.length - 1024);
                const fixtureOperations = entries
                  .slice(diagnosticStart)
                  .flatMap((entry, offset) => {
                    if (!isRecord(entry) || !isRecord(entry.fixtureAuthOperation)) {
                      return [];
                    }
                    const value = entry.fixtureAuthOperation;
                    const account = isRecord(value.account) ? value.account : undefined;
                    return [
                      {
                        index: diagnosticStart + offset,
                        version: typeof value.version === "number" ? value.version : null,
                        instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
                        sequence: typeof value.sequence === "number" ? value.sequence : null,
                        operation: typeof value.operation === "string" ? value.operation : null,
                        account: account
                          ? {
                              type: typeof account.type === "string" ? account.type : null,
                              accountId:
                                typeof account.accountId === "string" ? account.accountId : null,
                            }
                          : null,
                        threadId: typeof value.threadId === "string" ? value.threadId : null,
                        turnId: typeof value.turnId === "string" ? value.turnId : null,
                      },
                    ];
                  });
                correlationDiagnostic = {
                  controlStartIndex: controlCursor?.index ?? null,
                  observedEntryCount: entries.length,
                  omittedEntryCount: diagnosticStart,
                  fixtureOperations,
                  lifecycle: setupRunId
                    ? nativeLifecycleForRun(setupRunId)
                        .slice(-1024)
                        .map((event) => {
                          const payload = event.payload as CodexLifecyclePayload;
                          return {
                            event: event.event,
                            runId: payload.runId,
                            sessionKey: payload.sessionKey,
                            phase: payload.data?.phase,
                            threadId: payload.data?.threadId,
                            clientId: payload.data?.clientId,
                          };
                        })
                    : null,
                };
                expect(entries.length, "app-server history reached the tailer cap").toBeLessThan(
                  1024,
                );
                if (controlCursor) {
                  expect(entries.length).toBeGreaterThanOrEqual(controlCursor.index);
                  expect(
                    JSON.stringify(entries.slice(0, controlCursor.index)) === controlCursor.prefix,
                    "app-server history changed before the control cursor",
                  ).toBe(true);
                }
                expect(
                  (await fs.stat(requestLog)).size,
                  "app-server log reached the read cap",
                ).toBeLessThan(2 * 1024 * 1024);
                console.log(
                  `[qa-codex-native-account-control] ${JSON.stringify({
                    runId: setupRunId || null,
                    sessionKey: targetSessionKey,
                    expectedAccountId,
                    controlFailed,
                    captureComplete: true,
                    controlProof,
                    correlationDiagnostic,
                  })}`,
                );
              } catch (captureError) {
                console.error(
                  `[qa-codex-native-account-capture-failure] ${JSON.stringify({
                    runId: setupRunId || null,
                    sessionKey: targetSessionKey,
                    expectedAccountId,
                    controlFailed,
                    captureComplete: false,
                    controlProof,
                    correlationDiagnostic,
                  })}`,
                );
                if (!controlFailed) {
                  captureFailure = { error: captureError };
                }
              }
            }
          }
          if (captureFailure) {
            throw captureFailure.error;
          }
          return setupRunId;
        };
        await runConfiguredTurn("qa-codex-profile-binding-setup");
        expect(
          appServerLog.read().find((request) => request.method === "account/login/start")?.params,
        ).toMatchObject({ type: "chatgptAuthTokens", chatgptAccountId: configuredAccountId });
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
        const pinnedRunId = await runConfiguredTurn(
          "qa-codex-profile-binding-pinned",
          sessionKey,
          ACCOUNT_ID,
        );
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
        // The fixture restores durable threads from this log across account processes.
        // Freeze an evidence cursor instead of deleting the history needed by fallback.
        const beforeFailedTurn = appServerLog.read().length;
        const beforeFailedTurnPrefix = JSON.stringify(
          appServerLog.read().slice(0, beforeFailedTurn),
        );
        expect(beforeFailedTurn, "app-server history reached the tailer cap").toBeLessThan(1024);
        expect(
          (await fs.stat(requestLog)).size,
          "app-server log reached the read cap",
        ).toBeLessThan(2 * 1024 * 1024);
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
        expect(runId).toMatch(/\S/);
        expect(runId).not.toBe(pinnedRunId);
        terminal = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(terminal).toMatchObject({ runId, status: "error" });
        const settledLifecyclePayload = await vi.waitFor(
          () => {
            expect(
              events.find(
                (event) =>
                  event.event === "chat" &&
                  event.payload !== null &&
                  typeof event.payload === "object" &&
                  (event.payload as { runId?: unknown }).runId === runId &&
                  (event.payload as { state?: unknown }).state === "error",
              ),
            ).toBeDefined();
            const lifecycleEvent = events.find((event) => {
              if (
                event.event !== "sessions.changed" ||
                event.payload === null ||
                typeof event.payload !== "object"
              ) {
                return false;
              }
              const payload = event.payload as {
                sessionKey?: unknown;
                lastRunId?: unknown;
                status?: unknown;
                hasActiveRun?: unknown;
                activeRunIds?: unknown;
              };
              return (
                payload.sessionKey === sessionKey &&
                payload.lastRunId === runId &&
                payload.status === "failed" &&
                payload.hasActiveRun === false &&
                Array.isArray(payload.activeRunIds) &&
                payload.activeRunIds.length === 0
              );
            });
            expect(lifecycleEvent).toBeDefined();
            const lifecyclePayload = lifecycleEvent?.payload as
              | { lastRunError?: unknown }
              | undefined;
            expectBoundedMissingProfileRecovery(lifecyclePayload?.lastRunError, {
              allowSessionTruncation: true,
            });
            // Transcript and session-state events cover separate projections of the same failure.
            const transcriptEvent = events.find(
              (event) =>
                event.event === "session.message" &&
                event.payload !== null &&
                typeof event.payload === "object" &&
                (event.payload as { sessionKey?: unknown }).sessionKey === sessionKey &&
                (event.payload as { session?: { lastRunId?: unknown } }).session?.lastRunId ===
                  runId &&
                (event.payload as { session?: { status?: unknown } }).session?.status === "failed",
            );
            expect(transcriptEvent).toBeDefined();
            expectBoundedMissingProfileRecovery(
              (transcriptEvent?.payload as { session?: { lastRunError?: unknown } } | undefined)
                ?.session?.lastRunError,
              { allowSessionTruncation: true },
            );
            return lifecyclePayload;
          },
          { interval: 20, timeout: 5_000 },
        );

        await vi.waitFor(
          async () => {
            const listed = await client.request<{
              sessions?: Array<{
                key?: unknown;
                lastRunError?: unknown;
                lastRunId?: unknown;
                status?: unknown;
              }>;
            }>("sessions.list", { limit: 20 });
            const session = listed.sessions?.find((entry) => entry.key === sessionKey);
            expect(session).toMatchObject({ key: sessionKey, lastRunId: runId, status: "failed" });
            expectBoundedMissingProfileRecovery(session?.lastRunError, {
              allowSessionTruncation: true,
            });
          },
          { interval: 50, timeout: REQUEST_TIMEOUT_MS },
        );
        failedHistory = await client.request<GatewayHistory>(
          "chat.history",
          { agentId: "main", sessionKey, limit: 50 },
          { timeoutMs: 5_000 },
        );
        const readOriginalSession = () =>
          loadSessionEntryReadOnly({
            agentId: "main",
            sessionKey,
            storePath: resolveSessionStorePathCore(undefined, {
              agentId: "main",
              env: testInstance.env,
            }),
            env: testInstance.env,
            readConsistency: "latest",
            hydrateSkillPromptRefs: false,
          });
        const failedSession = readOriginalSession();
        expect(failedSession).toMatchObject({
          authProfileOverride: MISSING_PROFILE_ID,
          authProfileOverrideSource: "user",
          status: "failed",
          lastRunId: runId,
        });
        const failedRunLifecycle = structuredClone(nativeLifecycleForRun(runId));
        expect(failedRunLifecycle).toEqual([]);
        const retainedFailureEntries = appServerLog.read();
        const beforeConfiguredControl = retainedFailureEntries.length;
        expect(beforeConfiguredControl, "app-server history reached the tailer cap").toBeLessThan(
          1024,
        );
        expect(beforeConfiguredControl).toBeGreaterThanOrEqual(beforeFailedTurn);
        expect(
          (await fs.stat(requestLog)).size,
          "app-server log reached the read cap",
        ).toBeLessThan(2 * 1024 * 1024);
        expect(
          JSON.stringify(retainedFailureEntries.slice(0, beforeFailedTurn)) ===
            beforeFailedTurnPrefix,
          "app-server history changed before the failure cursor",
        ).toBe(true);
        const beforeConfiguredControlPrefix = JSON.stringify(retainedFailureEntries);
        const failureEntries = retainedFailureEntries.slice(beforeFailedTurn);
        const failureMethods = failureEntries.flatMap((entry) =>
          typeof entry.method === "string" ? [entry.method] : [],
        );
        // The shared log includes catalog discovery; retain its methods as diagnostics
        // before a new session proves A is still usable, without attributing them to B.
        let configuredRunId: string | undefined;
        if (configuredProfileId !== MISSING_PROFILE_ID) {
          configuredRunId = await runConfiguredTurn(
            "qa-codex-configured-account-survives",
            `${sessionKey}-configured`,
            configuredAccountId,
          );
          expect(configuredRunId).not.toBe(pinnedRunId);
          expect(configuredRunId).not.toBe(runId);
          const controlEntries = appServerLog.read();
          expect(controlEntries.length, "app-server history reached the tailer cap").toBeLessThan(
            1024,
          );
          expect(controlEntries.length).toBeGreaterThanOrEqual(beforeConfiguredControl);
          expect(
            (await fs.stat(requestLog)).size,
            "app-server log reached the read cap",
          ).toBeLessThan(2 * 1024 * 1024);
          expect(
            JSON.stringify(controlEntries.slice(0, beforeConfiguredControl)) ===
              beforeConfiguredControlPrefix,
            "app-server history changed before the control cursor",
          ).toBe(true);
        }
        const finalEvent = events.find(
          (event) =>
            event.event === "chat" &&
            event.payload !== null &&
            typeof event.payload === "object" &&
            (event.payload as { runId?: unknown }).runId === runId &&
            (event.payload as { state?: unknown }).state === "error",
        );
        expectBoundedMissingProfileRecovery(finalEvent?.payload);
        // OpenClaw can settle an admitted run before provider operational RPC;
        // host lifecycle publication does not imply provider execution.
        expectBoundedMissingProfileRecovery(settledLifecyclePayload?.lastRunError, {
          allowSessionTruncation: true,
        });
        expectBoundedMissingProfileRecovery(terminal);
        expectBoundedMissingProfileRecovery(failedHistory?.sessionInfo?.lastRunError, {
          allowSessionTruncation: true,
        });
        expect(JSON.stringify(failedHistory)).not.toContain(MISSING_PROFILE_ID);
        expect(JSON.stringify(failedHistory)).not.toContain("Codex app-server auth profile");

        let recoveryRunId: string | undefined;
        if (configuredProfileId !== MISSING_PROFILE_ID) {
          // Recovery must repair the failed session, not succeed only in a fresh session.
          const originalSession = readOriginalSession();
          expect(originalSession).toMatchObject({
            authProfileOverride: MISSING_PROFILE_ID,
            authProfileOverrideSource: "user",
            status: "failed",
            lastRunId: runId,
          });
          const originalSessionId = originalSession?.sessionId;
          const originalLifecycleRevision = originalSession?.lifecycleRevision;
          expect(originalSessionId).toMatch(/\S/);
          const recoveredSelection = {
            sessionId: originalSessionId,
            lifecycleRevision: originalLifecycleRevision,
            authProfileOverride: configuredProfileId,
            authProfileOverrideSource: "user",
          };
          await expect(
            client.request("sessions.patch", {
              key: sessionKey,
              expectedSessionId: originalSessionId,
              ...(originalLifecycleRevision !== undefined
                ? { expectedLifecycleRevision: originalLifecycleRevision }
                : {}),
              model: `${MODEL}@${configuredProfileId}`,
            }),
          ).resolves.toMatchObject({ ok: true, key: sessionKey, entry: recoveredSelection });
          expect(readOriginalSession()).toMatchObject(recoveredSelection);
          recoveryRunId = await runConfiguredTurn(
            "qa-codex-original-session-recovered",
            sessionKey,
            configuredAccountId,
          );
          expect(recoveryRunId).not.toBe(pinnedRunId);
          expect(recoveryRunId).not.toBe(runId);
          expect(recoveryRunId).not.toBe(configuredRunId);
          await vi.waitFor(
            () => {
              const recoveredSession = readOriginalSession();
              expect(recoveredSession).toMatchObject({
                ...recoveredSelection,
                status: "done",
                lastRunId: recoveryRunId,
              });
              expect(recoveredSession?.lastRunError).toBeUndefined();
              expect(
                events.find(
                  (event) =>
                    event.event === "chat" &&
                    isRecord(event.payload) &&
                    event.payload.runId === recoveryRunId &&
                    event.payload.sessionKey === sessionKey &&
                    event.payload.state === "final",
                ),
              ).toBeDefined();
            },
            { interval: 25, timeout: REQUEST_TIMEOUT_MS },
          );
          console.log(
            `[qa-codex-original-session-recovery] ${JSON.stringify({
              sessionKey,
              ...recoveredSelection,
              runId: recoveryRunId,
              accountId: configuredAccountId,
              status: "done",
            })}`,
          );
        }

        console.log(
          `[qa-codex-missing-auth-profile] ${JSON.stringify({
            assistantOutput: SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT,
            configuredAccountControl:
              configuredProfileId !== MISSING_PROFILE_ID ? "passed" : "same-account-removed",
            historySessionKey: sessionKey,
            recoveryRunId: recoveryRunId ?? null,
            appServerInitialized: failureMethods.includes("initialize"),
            failedRunNativeLifecycleCount: failedRunLifecycle.length,
            observedAppServerMethods: failureMethods,
          })}`,
        );
      } finally {
        client.stop();
      }
    },
  );
});
