import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { expect, type TestContext } from "vitest";
import { WebSocketServer } from "ws";
import { readPersistedSharedAuthProfileStateRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import { coerceAuthProfileState } from "../../../../src/agents/auth-profiles/state.js";
import { connectGatewayClient } from "../../../../src/gateway/test-helpers.e2e.js";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../../../src/state/openclaw-state-db.paths.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

export const BACKUP_MODEL = "quota-backup/echo";
export const BACKUP_MARKER = "QUOTA_BACKUP_OK";
export const BACKUP_API_KEY = "synthetic-quota-backup-key";
export const BACKUP_RESPONSES_PATH = "/quota-backup/responses";

const MODEL = "openai/gpt-5.5";
export const UTILITY_MODEL_ID = "quota-test-utility";
const PROFILE_ID = "openai:quota";
export const ACCOUNT_ID = "quota-test-account";
export const MARKER = "QUOTA_TURN_OK";
const RECHECK_ADVANCE_MS = 300_100;
type BlockSource = "wham" | "codex_rate_limits";
type Phase =
  | "healthy"
  | "initial-exhaustion"
  | "ordinary-rate-limit"
  | "ordinary-rate-limit-with-capacity"
  | "ordinary-rate-limit-with-exhausted-usage"
  | "exhausted"
  | "additional-exhaustion"
  | "workspace-exhaustion"
  | "spending-exhaustion"
  | "malformed-usage"
  | "restored"
  | "revoked";
type RequestRecord = {
  phase: Phase;
  transport: "http" | "websocket";
  path: string;
  method: string | undefined;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: string | undefined;
  bodyBase64?: string;
  authorization: string | undefined;
  accountId: string | string[] | undefined;
};
type ChatHistory = {
  messages: Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  }>;
};
type HeldUsageResponse = {
  phase: Phase;
  path: string;
  status: number;
  body: string;
  capturedAt: number;
  releasedAt?: number;
  releaseReason?: "explicit" | "deadline" | "aborted";
};

export function syntheticAccessToken(expires = Date.UTC(2036, 0, 1), accountId = ACCOUNT_ID) {
  return [
    { alg: "none" },
    {
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_user_id: "quota-test-user",
        chatgpt_plan_type: "pro",
      },
      exp: Math.floor(expires / 1000),
      email: "quota@example.invalid",
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .concat("synthetic")
    .join(".");
}

function assistantTexts(history: ChatHistory): string[] {
  return history.messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n"),
    );
}

async function startQuotaProvider(source: BlockSource, responseText: string) {
  let phase: Phase = "healthy";
  let nextSuccessObserver: (() => void) | undefined;
  let nextUsageHold: { arrived: Deferred<HeldUsageResponse>; released: Deferred<void> } | undefined;
  const heldUsageResponses: HeldUsageResponse[] = [];
  const resetAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const requests: RequestRecord[] = [];
  const responses: Array<{
    phase: Phase;
    path: string;
    value: unknown;
    headers?: Record<string, string>;
  }> = [];
  const errors: string[] = [];
  const primaryExhausted = () => phase === "initial-exhaustion" || phase === "exhausted";
  const exhausted = () => phase !== "healthy" && phase !== "restored" && phase !== "revoked";
  const recordRequest = (
    request: IncomingMessage,
    body: string | undefined,
    transport: RequestRecord["transport"],
    bodyBytes?: Buffer,
  ) => {
    requests.push({
      phase,
      transport,
      path: request.url ?? "",
      method: request.method,
      headers: request.headers,
      rawHeaders: request.rawHeaders,
      body,
      bodyBase64: bodyBytes?.toString("base64"),
      authorization: request.headers.authorization,
      accountId: request.headers["chatgpt-account-id"],
    });
  };
  const usage = () => {
    const usageExhausted =
      primaryExhausted() || phase === "ordinary-rate-limit-with-exhausted-usage";
    const window = (seconds: number, usedPercent = usageExhausted ? 100 : 2) => ({
      used_percent: usedPercent,
      limit_window_seconds: seconds,
      reset_at: resetAt,
      reset_after_seconds: resetAt - Math.floor(Date.now() / 1000),
    });
    return {
      plan_type: "pro",
      rate_limit: {
        allowed: !usageExhausted,
        limit_reached: usageExhausted,
        primary_window: window(18_000),
        secondary_window: window(604_800),
      },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      additional_rate_limits:
        phase === "additional-exhaustion"
          ? [
              {
                limit_name: "Additional Codex capacity",
                metered_feature: "codex_other",
                rate_limit: {
                  allowed: false,
                  limit_reached: true,
                  primary_window: window(18_000, 100),
                  secondary_window: null,
                },
              },
            ]
          : [],
      spend_control:
        phase === "malformed-usage"
          ? { reached: "invalid" }
          : phase === "spending-exhaustion"
            ? { reached: true }
            : null,
      rate_limit_reached_type:
        phase === "workspace-exhaustion" ? { type: "workspace_owner_credits_depleted" } : null,
    };
  };
  const failure = () => {
    const headers: Record<string, string> =
      primaryExhausted() && source === "codex_rate_limits"
        ? {
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": String(resetAt),
            "x-codex-secondary-used-percent": "100",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-at": String(resetAt),
          }
        : {};
    return {
      type: "error",
      status: phase === "revoked" ? 401 : 429,
      error:
        phase === "revoked"
          ? {
              type: "invalid_request_error",
              code: "invalid_api_key",
              message: "Invalid authentication token",
            }
          : phase === "ordinary-rate-limit" ||
              phase === "ordinary-rate-limit-with-capacity" ||
              phase === "ordinary-rate-limit-with-exhausted-usage"
            ? {
                type: "rate_limit_error",
                code: "rate_limit_exceeded",
                message: "Too many requests",
              }
            : {
                type: "usage_limit_reached",
                message: "The usage limit has been reached",
                plan_type: "pro",
                ...(source === "codex_rate_limits" ? { resets_at: resetAt } : {}),
              },
      headers,
    };
  };
  const successEvents = (marker = responseText) => {
    const observe = nextSuccessObserver;
    nextSuccessObserver = undefined;
    observe?.();
    const id = randomUUID().replaceAll("-", "");
    const item = {
      type: "message",
      id: `msg${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: marker, annotations: [] }],
    };
    const response = {
      id: `resp${id}`,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 0 },
      },
    };
    return [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: marker,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const bodyBytes = Buffer.concat(chunks);
      const encoding = request.headers["content-encoding"];
      const decoded =
        encoding === undefined
          ? bodyBytes
          : encoding === "zstd"
            ? zstdDecompressSync(bodyBytes)
            : undefined;
      recordRequest(request, decoded?.toString(), "http", bodyBytes);
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const json = (
        status: number,
        value: unknown,
        headers: Record<string, string> = {},
        responsePhase = phase,
      ) => {
        responses.push({ phase: responsePhase, path: requestPath, value, headers });
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (requestPath === "/core-wham/usage" || requestPath === "/backend-api/wham/usage") {
        // Preserve the native block source only on the original quota failure.
        if (
          requestPath === "/core-wham/usage" &&
          ((source === "codex_rate_limits" && phase === "initial-exhaustion") ||
            phase === "ordinary-rate-limit")
        ) {
          json(503, { error: { message: "Usage view temporarily unavailable" } });
        } else if (phase === "revoked") {
          json(403, { error: { message: "Account deactivated" } });
        } else {
          const value = usage();
          const hold = requestPath === "/core-wham/usage" ? nextUsageHold : undefined;
          if (hold) {
            nextUsageHold = undefined;
            const captured: HeldUsageResponse = {
              phase,
              path: requestPath,
              status: 200,
              body: JSON.stringify(value),
              capturedAt: Date.now(),
            };
            heldUsageResponses.push(captured);
            hold.arrived.resolve(captured);
            const interrupted = createDeferredCore<"deadline" | "aborted">();
            const timer = setTimeout(() => interrupted.resolve("deadline"), 2800);
            const onClose = () => interrupted.resolve("aborted");
            response.once("close", onClose);
            try {
              captured.releaseReason = await Promise.race([
                hold.released.promise.then(() => "explicit" as const),
                interrupted.promise,
              ]);
              captured.releasedAt = Date.now();
              if (captured.releaseReason !== "aborted") {
                json(captured.status, value, {}, captured.phase);
              }
            } finally {
              clearTimeout(timer);
              response.off("close", onClose);
            }
          } else {
            json(200, value);
          }
        }
      } else if (requestPath === "/oauth/token") {
        if (phase === "revoked") {
          json(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
        } else {
          json(200, {
            access_token: syntheticAccessToken(),
            refresh_token: "synthetic-rotated-refresh",
            expires_in: 3600,
          });
        }
      } else if (requestPath === "/catalog/models") {
        json(200, {
          models: [
            {
              slug: "gpt-5.5",
              display_name: "Quota fixture model",
              visibility: "list",
              show_in_picker: true,
              context_window: 128_000,
              max_output_tokens: 4096,
            },
          ],
        });
      } else if (requestPath.endsWith("/models")) {
        json(200, { models: [] });
      } else if (requestPath.endsWith("/responses")) {
        const backup = requestPath === BACKUP_RESPONSES_PATH;
        if (!backup && (exhausted() || phase === "revoked")) {
          const event = failure();
          json(event.status, { error: event.error }, event.headers);
        } else {
          const events = successEvents(backup ? BACKUP_MARKER : responseText);
          responses.push({ phase, path: requestPath, value: events });
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of events) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        }
      } else {
        json(404, { error: { message: "No synthetic fixture for this route" } });
      }
    })().catch((error: unknown) => {
      errors.push(String(error));
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on("error", (error) => errors.push(String(error)));
      websocket.on("message", (raw) => {
        recordRequest(request, raw.toString(), "websocket");
        const events = exhausted() || phase === "revoked" ? [failure()] : successEvents();
        for (const event of events) {
          responses.push({ phase, path: request.url ?? "", value: event });
          websocket.send(JSON.stringify(event));
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind loopback");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    responses,
    heldUsageResponses,
    errors,
    setPhase(next: Phase) {
      phase = next;
    },
    observeNextSuccess(observer: () => void) {
      nextSuccessObserver = observer;
    },
    holdNextUsage() {
      if (nextUsageHold) {
        throw new Error("A usage response hold is already armed");
      }
      const hold = {
        arrived: createDeferredCore<HeldUsageResponse>(),
        released: createDeferredCore<void>(),
      };
      nextUsageHold = hold;
      return { arrived: hold.arrived.promise, release: () => hold.released.resolve() };
    },
    async stop() {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function createQuotaResetFixture(
  context: TestContext,
  {
    source,
    expiresDuringBlock = false,
    scopedCooldown = false,
    includeBackup = false,
    limitGatewayFileSize = false,
    runtime = "codex",
    enableIsolatedTool = false,
    includeAlternateProfile = false,
    responseText = MARKER,
    controlUi = false,
  }: {
    source: BlockSource;
    expiresDuringBlock?: boolean;
    scopedCooldown?: boolean;
    includeBackup?: boolean;
    limitGatewayFileSize?: boolean;
    runtime?: "openclaw" | "codex";
    enableIsolatedTool?: boolean;
    includeAlternateProfile?: boolean;
    responseText?: string;
    controlUi?: boolean;
  },
) {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => context.onTestFinished(cleanup));
  const root = tempDirs.make("openclaw-quota-reset-");
  const provider = await startQuotaProvider(source, responseText);
  context.onTestFinished(() => provider.stop());
  const clockFile = path.join(root, "clock-offset");
  await fs.writeFile(clockFile, "0");
  const storageFaultFile = path.join(root, "storage-fault");
  await fs.writeFile(storageFaultFile, "null");
  let offset = 0;
  const advanceClock = async (
    advanceMs = expiresDuringBlock ? 2 * 86_400_000 + RECHECK_ADVANCE_MS : RECHECK_ADVANCE_MS,
  ) => {
    offset += advanceMs;
    await fs.writeFile(`${clockFile}.next`, String(offset));
    await fs.rename(`${clockFile}.next`, clockFile);
  };
  const preload = new URL("./quota-reset-preload.mjs", import.meta.url);
  preload.searchParams.set("fixture", provider.baseUrl);
  preload.searchParams.set("clock", clockFile);
  if (controlUi) {
    preload.searchParams.set("catalog", "1");
  }
  if (limitGatewayFileSize) {
    preload.searchParams.set("storageFault", storageFaultFile);
  }
  const requireCodex = createRequire(
    new URL("../../../../extensions/codex/package.json", import.meta.url),
  );
  const launcher = path.join(
    path.dirname(requireCodex.resolve("@openai/codex/package.json")),
    "bin/codex.js",
  );
  const gateway = await createOpenClawTestInstance({
    name: `quota-reset-${source}`,
    gatewayCommandPrefix: limitGatewayFileSize
      ? [
          "/bin/sh",
          "-c",
          `ulimit -f 65536; exec "$@"`,
          "quota-storage-fault",
          process.execPath,
          "--import",
          preload.href,
        ]
      : [process.execPath, "--import", preload.href],
    startTimeoutMs: 120_000,
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
    },
    config: {
      gateway: { controlUi: { enabled: controlUi } },
      ...(enableIsolatedTool ? { tools: { alsoAllow: ["llm-task"] } } : {}),
      ...(scopedCooldown || includeBackup
        ? {
            models: {
              providers: {
                ...(scopedCooldown
                  ? {
                      openai: {
                        baseUrl: "https://chatgpt.com/backend-api/codex",
                        api: "openai-chatgpt-responses" as const,
                        auth: "oauth" as const,
                        models: ["gpt-5.5", UTILITY_MODEL_ID].map((id) => ({
                          id,
                          name: id,
                          reasoning: false,
                          input: ["text" as const],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 128_000,
                          maxTokens: 4096,
                        })),
                      },
                    }
                  : {}),
                ...(includeBackup
                  ? {
                      "quota-backup": {
                        baseUrl: `${provider.baseUrl}/quota-backup`,
                        api: "openai-responses" as const,
                        apiKey: BACKUP_API_KEY,
                        request: { allowPrivateNetwork: true },
                        models: [
                          {
                            id: "echo",
                            name: "Quota backup echo",
                            reasoning: false,
                            input: ["text" as const],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 128_000,
                            maxTokens: 256,
                          },
                        ],
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      plugins: {
        enabled: true,
        allow: ["codex", "openai", ...(enableIsolatedTool ? ["llm-task"] : [])],
        entries: {
          ...(enableIsolatedTool
            ? { "llm-task": { enabled: true, llm: { allowAuthProfileOverride: true } } }
            : {}),
          codex: {
            enabled: true,
            config: {
              appServer: {
                mode: "yolo",
                command: process.execPath,
                args: [
                  launcher,
                  "app-server",
                  "-c",
                  `chatgpt_base_url="${provider.baseUrl}/backend-api"`,
                  "-c",
                  `openai_base_url="${provider.baseUrl}/v1"`,
                ],
                requestTimeoutMs: 60_000,
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: MODEL, fallbacks: includeBackup ? [BACKUP_MODEL] : [] },
          models: {
            [MODEL]: { agentRuntime: { id: runtime } },
            ...(includeBackup ? { [BACKUP_MODEL]: { agentRuntime: { id: "openclaw" } } } : {}),
          },
          ...(scopedCooldown ? { utilityModel: `openai/${UTILITY_MODEL_ID}` } : {}),
          workspace: "~/workspace",
          skipBootstrap: true,
          timeoutSeconds: 90,
          sandbox: { mode: "off" },
        },
      },
    },
  });
  context.onTestFinished(() => gateway.cleanup());
  context.onTestFailed(() => console.error(gateway.logs()));
  // Doctor imports without refreshing a credential outside its one-day warning window.
  const expires = expiresDuringBlock ? Date.now() + 2 * 86_400_000 : Date.UTC(2036, 0, 1);
  const access = syntheticAccessToken(expires);
  const alternateProfileId = "openai:quota-alternate";
  const alternateAccess = syntheticAccessToken(expires, "quota-alternate-account");
  await gateway.state.writeText(
    "agents/main/agent/auth-profiles.json",
    JSON.stringify({
      version: 1,
      profiles: {
        ...(includeAlternateProfile
          ? {
              [alternateProfileId]: {
                type: "oauth",
                provider: "openai",
                access: alternateAccess,
                refresh: "synthetic-alternate-refresh",
                expires,
                accountId: "quota-alternate-account",
              },
            }
          : {}),
        [PROFILE_ID]: {
          type: "oauth",
          provider: "openai",
          access,
          refresh: "synthetic-refresh",
          expires,
          accountId: ACCOUNT_ID,
        },
      },
      order: { openai: [PROFILE_ID] },
    }),
  );
  const doctor = await gateway.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
    timeoutMs: 120_000,
  });
  expect(doctor.code, doctor.stderr).toBe(0);
  await gateway.startGateway();
  gateway.child?.once("exit", (code, signal) =>
    console.error("Quota fixture Gateway exit", { code, signal }),
  );
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${gateway.port}`,
    token: gateway.gatewayToken,
    clientName: "cli",
    mode: "cli",
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
  context.onTestFinished(() => client.stopAndWait());
  const sessionKey = `agent:main:quota-${randomUUID()}`;
  const turns: unknown[] = [];
  const stats = () =>
    coerceAuthProfileState(readPersistedSharedAuthProfileStateRaw(gateway.env)).usageStats?.[
      PROFILE_ID
    ];
  const evidence = () =>
    JSON.stringify(
      {
        requests: provider.requests,
        responses: provider.responses,
        heldUsageResponses: provider.heldUsageResponses,
        errors: provider.errors,
        turns,
        stats: stats(),
        gateway: gateway.logs(),
      },
      null,
      2,
    );
  const turn = async (key = sessionKey, message = `Return ${MARKER}.`) => {
    const before = assistantTexts(
      await client.request<ChatHistory>("chat.history", { sessionKey: key, limit: 100 }),
    );
    const started = await client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey: key,
      message,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(started.status, evidence()).toBe("started");
    const terminal = await client.request<{ status: string; error?: unknown }>(
      "agent.wait",
      { runId: started.runId, timeoutMs: 100_000 },
      { timeoutMs: 105_000 },
    );
    const history = await client.request<ChatHistory>("chat.history", {
      sessionKey: key,
      limit: 100,
    });
    turns.push({ started, terminal, history });
    const after = assistantTexts(history);
    expect(["ok", "error"], JSON.stringify({ terminal, evidence: evidence() })).toContain(
      terminal.status,
    );
    return { status: terminal.status, output: after.slice(before.length) };
  };
  return {
    gateway,
    client,
    provider,
    sessionKey,
    access,
    profileId: PROFILE_ID,
    alternateProfileId,
    alternateAccess,
    advanceClock,
    clock: {
      get offset() {
        return offset;
      },
    },
    stats,
    evidence,
    turn,
    turns,
    storageFaultFile,
  };
}

export async function installQuotaStateWriteFault(
  gateway: OpenClawTestInstance,
  storageFaultFile: string,
  write: "claim" | "result",
  failure: "io" | "constraint",
) {
  const databasePath = resolveOpenClawStateSqlitePath(gateway.env);
  await fs.writeFile(`${storageFaultFile}.next`, JSON.stringify({ write, failure }));
  await fs.rename(`${storageFaultFile}.next`, storageFaultFile);
  return {
    scratchCommitted() {
      const reader = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT name FROM main.sqlite_schema WHERE name = 'quota_reset_write_fault'")
            .all(),
        ).toEqual([]);
        return (
          reader
            .prepare("SELECT 1 FROM config_machine_state WHERE state_key = ?")
            .get("quota-reset-test.scratch") !== undefined
        );
      } finally {
        reader.close();
      }
    },
    async remove() {
      await fs.writeFile(`${storageFaultFile}.next`, "null");
      await fs.rename(`${storageFaultFile}.next`, storageFaultFile);
    },
  };
}
