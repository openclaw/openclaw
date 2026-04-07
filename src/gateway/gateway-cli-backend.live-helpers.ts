import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const execFileAsync = promisify(execFile);
const CLI_GATEWAY_CONNECT_TIMEOUT_MS = 30_000;

export const DEFAULT_CLAUDE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
  "--permission-mode",
  "bypassPermissions",
];

export const DEFAULT_CODEX_ARGS = [
  "exec",
  "--json",
  "--color",
  "never",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
];

export const DEFAULT_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

export type BootstrapWorkspaceContext = {
  expectedInjectedFiles: string[];
  workspaceDir: string;
  workspaceRootDir: string;
};

export type SystemPromptReport = {
  injectedWorkspaceFiles?: Array<{ name?: string }>;
};

export type CronListCliResult = {
  jobs?: Array<{
    id?: string;
    name?: string;
    sessionTarget?: string;
    agentId?: string | null;
    sessionKey?: string | null;
    payload?: { kind?: string; text?: string; message?: string };
  }>;
};

type CronListJob = NonNullable<CronListCliResult["jobs"]>[number];

export type CliBackendLiveEnvSnapshot = {
  configPath?: string;
  stateDir?: string;
  token?: string;
  skipChannels?: string;
  skipGmail?: string;
  skipCron?: string;
  skipCanvas?: string;
  skipBrowserControl?: string;
  anthropicApiKey?: string;
  anthropicApiKeyOld?: string;
};

export function randomImageProbeCode(len = 6): string {
  // Chosen to avoid common OCR confusions in our 5x7 bitmap font.
  // Notably: 0↔8, B↔8, 6↔9, 3↔B, D↔0.
  const alphabet = "24567ACEF";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function parseJsonStringArray(name: string, raw?: string): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

export function parseImageMode(raw?: string): "list" | "repeat" | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "list" || trimmed === "repeat") {
    return trimmed;
  }
  throw new Error("OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE must be 'list' or 'repeat'.");
}

export function shouldRunCliImageProbe(providerId: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return providerId === "claude-cli";
}

export function matchesCliBackendReply(text: string, expected: string): boolean {
  const normalized = text.trim();
  const target = expected.trim();
  return normalized === target || normalized === target.slice(0, -1);
}

export function withMcpConfigOverrides(args: string[], mcpConfigPath: string): string[] {
  const next = [...args];
  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  if (!next.includes("--mcp-config")) {
    next.push("--mcp-config", mcpConfigPath);
  }
  return next;
}

export async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 40_000,
  });
}

export async function createBootstrapWorkspace(
  tempDir: string,
): Promise<BootstrapWorkspaceContext> {
  const workspaceRootDir = path.join(tempDir, "workspace");
  const workspaceDir = path.join(workspaceRootDir, "dev");
  const expectedInjectedFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add extra punctuation when the user asks for an exact response.",
    ].join("\n"),
  );
  await fs.writeFile(path.join(workspaceDir, "SOUL.md"), `SOUL-${randomUUID()}\n`);
  await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), `IDENTITY-${randomUUID()}\n`);
  await fs.writeFile(path.join(workspaceDir, "USER.md"), `USER-${randomUUID()}\n`);
  return { expectedInjectedFiles, workspaceDir, workspaceRootDir };
}

export async function runOpenClawCliJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const childEnv = { ...env };
  delete childEnv.VITEST;
  delete childEnv.VITEST_MODE;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
    cwd: process.cwd(),
    env: childEnv,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} produced no JSON stdout`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} returned invalid JSON`,
        `stdout: ${trimmed}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
        error instanceof Error ? `cause: ${error.message}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectTestGatewayClient(params: {
  url: string;
  token: string;
  deviceIdentity?: DeviceIdentity;
}): Promise<GatewayClient> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt < CLI_GATEWAY_CONNECT_TIMEOUT_MS) {
    attempt += 1;
    const remainingMs = CLI_GATEWAY_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await connectClientOnce({
        ...params,
        timeoutMs: Math.min(remainingMs, 35_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableGatewayConnectError(lastError) || remainingMs <= 5_000) {
        throw lastError;
      }
      await sleep(Math.min(1_000 * attempt, 5_000));
    }
  }

  throw lastError ?? new Error("gateway connect timeout");
}

async function connectClientOnce(params: {
  url: string;
  token: string;
  timeoutMs: number;
  deviceIdentity?: DeviceIdentity;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };

    const failWithClose = (code: number, reason: string) =>
      finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) });

    client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      requestTimeoutMs: params.timeoutMs,
      connectChallengeTimeoutMs: params.timeoutMs,
      deviceIdentity: params.deviceIdentity,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: failWithClose,
    });

    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      params.timeoutMs,
    );
    connectTimeout.unref();
    client.start();
  });
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway closed during connect (1000)") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway connect challenge timeout") ||
    message.includes("gateway request timeout for connect") ||
    message.includes("gateway client stopped")
  );
}

export function snapshotCliBackendLiveEnv(): CliBackendLiveEnvSnapshot {
  return {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipBrowserControl: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicApiKeyOld: process.env.ANTHROPIC_API_KEY_OLD,
  };
}

export function applyCliBackendLiveEnv(preservedEnv: ReadonlySet<string>): void {
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  if (!preservedEnv.has("ANTHROPIC_API_KEY")) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  if (!preservedEnv.has("ANTHROPIC_API_KEY_OLD")) {
    delete process.env.ANTHROPIC_API_KEY_OLD;
  }
}

export function restoreCliBackendLiveEnv(snapshot: CliBackendLiveEnvSnapshot): void {
  restoreEnvVar("OPENCLAW_CONFIG_PATH", snapshot.configPath);
  restoreEnvVar("OPENCLAW_STATE_DIR", snapshot.stateDir);
  restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", snapshot.token);
  restoreEnvVar("OPENCLAW_SKIP_CHANNELS", snapshot.skipChannels);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", snapshot.skipGmail);
  restoreEnvVar("OPENCLAW_SKIP_CRON", snapshot.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", snapshot.skipCanvas);
  restoreEnvVar("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", snapshot.skipBrowserControl);
  restoreEnvVar("ANTHROPIC_API_KEY", snapshot.anthropicApiKey);
  restoreEnvVar("ANTHROPIC_API_KEY_OLD", snapshot.anthropicApiKeyOld);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function ensurePairedTestGatewayClientIdentity(): Promise<DeviceIdentity> {
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const requiredScopes = ["operator.admin"];
  const paired = await getPairedDevice(identity.deviceId);
  const pairedScopes = Array.isArray(paired?.approvedScopes)
    ? paired.approvedScopes
    : Array.isArray(paired?.scopes)
      ? paired.scopes
      : [];
  if (
    paired?.publicKey === publicKey &&
    requiredScopes.every((scope) => pairedScopes.includes(scope))
  ) {
    return identity;
  }
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    displayName: "vitest",
    platform: process.platform,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: requiredScopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: requiredScopes,
  });
  if (approved?.status !== "approved") {
    throw new Error(
      `failed to pre-pair live test device: ${approved?.status ?? "missing-approval-result"}`,
    );
  }
  return identity;
}

export async function verifyCliBackendImageProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  tempDir: string;
  bootstrapWorkspace: BootstrapWorkspaceContext | null;
}): Promise<void> {
  const imageCode = randomImageProbeCode();
  const imageBase64 = renderCatNoncePngBase64(imageCode);
  const runIdImage = randomUUID();
  const imageFilePath = path.join(
    params.bootstrapWorkspace?.workspaceDir ?? params.tempDir,
    `probe-${runIdImage}.png`,
  );
  await fs.writeFile(imageFilePath, Buffer.from(imageBase64, "base64"));

  const imageProbe = await params.client.request(
    "agent",
    params.providerId === "claude-cli"
      ? {
          sessionKey: params.sessionKey,
          idempotencyKey: `idem-${runIdImage}-image`,
          message:
            `Image path: ${imageFilePath}\n` +
            "Best match: lobster, mouse, cat, horse. " +
            "Reply with one lowercase word only.",
          deliver: false,
        }
      : {
          sessionKey: params.sessionKey,
          idempotencyKey: `idem-${runIdImage}-image`,
          message:
            "Best match for the attached image: lobster, mouse, cat, horse. " +
            "Reply with one lowercase word only.",
          attachments: [
            {
              mimeType: "image/png",
              fileName: `probe-${runIdImage}.png`,
              content: imageBase64,
            },
          ],
          deliver: false,
        },
    { expectFinal: true },
  );
  if (imageProbe?.status !== "ok") {
    throw new Error(`image probe failed: status=${String(imageProbe?.status)}`);
  }
  const imageText = extractPayloadText(imageProbe?.result).trim().toLowerCase();
  if (imageText !== "cat") {
    throw new Error(`image probe expected 'cat', got: ${imageText}`);
  }
}

export async function verifyClaudeCliCronMcpProbe(params: {
  client: GatewayClient;
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cronProbeNonce = randomBytes(3).toString("hex").toUpperCase();
  const cronProbeName = `live-mcp-${cronProbeNonce.toLowerCase()}`;
  const cronProbeMessage = `probe-${cronProbeNonce.toLowerCase()}`;
  const cronProbeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const cronArgsJson = JSON.stringify({
    action: "add",
    job: {
      name: cronProbeName,
      schedule: { kind: "at", at: cronProbeAt },
      payload: { kind: "agentTurn", message: cronProbeMessage },
      sessionTarget: "current",
      enabled: true,
    },
  });

  let createdJob: CronListJob | undefined;
  let lastCronText = "";

  for (let attempt = 0; attempt < 2 && !createdJob; attempt += 1) {
    const runIdMcp = randomUUID();
    const cronProbe = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${runIdMcp}-mcp-${attempt}`,
        message:
          attempt === 0
            ? "Use the OpenClaw MCP tool named cron. " +
              `Call it with JSON arguments ${cronArgsJson}. ` +
              "Do the actual tool call; I will verify externally with the OpenClaw cron CLI. " +
              `After the cron job is created, reply exactly: ${cronProbeName}`
            : "Return only a tool call for the OpenClaw MCP tool `cron`. " +
              `Use these exact JSON arguments: ${cronArgsJson}. ` +
              "No prose. I will verify externally with the OpenClaw cron CLI.",
        deliver: false,
      },
      { expectFinal: true },
    );
    if (cronProbe?.status !== "ok") {
      throw new Error(`cron mcp probe failed: status=${String(cronProbe?.status)}`);
    }
    lastCronText = extractPayloadText(cronProbe?.result).trim();
    createdJob = await assertCronJobVisibleViaCli({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: cronProbeName,
      expectedMessage: cronProbeMessage,
    });
    if (!createdJob && attempt === 1) {
      throw new Error(
        `cron cli verify could not find job ${cronProbeName}: reply=${JSON.stringify(lastCronText)}`,
      );
    }
  }

  if (!createdJob) {
    throw new Error(`cron cli verify did not create job ${cronProbeName}`);
  }
  expect(createdJob.name).toBe(cronProbeName);
  expect(createdJob?.payload?.kind).toBe("agentTurn");
  expect(createdJob?.payload?.message).toBe(cronProbeMessage);
  expect(createdJob?.agentId).toBe("dev");
  expect(createdJob?.sessionKey).toBe(params.sessionKey);
  expect(createdJob?.sessionTarget).toBe(`session:${params.sessionKey}`);
  if (createdJob?.id) {
    await runOpenClawCliJson(
      [
        "cron",
        "rm",
        createdJob.id,
        "--json",
        "--url",
        `ws://127.0.0.1:${params.port}`,
        "--token",
        params.token,
      ],
      params.env,
    );
  }
}

export async function assertCronJobVisibleViaCli(params: {
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  expectedName: string;
  expectedMessage: string;
}): Promise<CronListJob | undefined> {
  const cronList = await runOpenClawCliJson<CronListCliResult>(
    [
      "cron",
      "list",
      "--all",
      "--json",
      "--url",
      `ws://127.0.0.1:${params.port}`,
      "--token",
      params.token,
    ],
    params.env,
  );
  return (
    cronList.jobs?.find((job) => job.name === params.expectedName) ??
    cronList.jobs?.find((job) => job.payload?.message === params.expectedMessage)
  );
}
