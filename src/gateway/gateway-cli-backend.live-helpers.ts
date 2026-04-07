import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliBackendLiveTest } from "../agents/cli-backends.js";
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
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
  type CronListJob,
} from "./live-agent-probes.js";
import { renderCatFacePngBase64 } from "./live-image-probe.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

// Aggregate docker live runs can contend on startup enough that the gateway
// websocket handshake needs a wider budget than the single-provider reruns.
const CLI_GATEWAY_CONNECT_TIMEOUT_MS = 60_000;

export type BootstrapWorkspaceContext = {
  expectedInjectedFiles: string[];
  workspaceDir: string;
  workspaceRootDir: string;
};

export type SystemPromptReport = {
  injectedWorkspaceFiles?: Array<{ name?: string }>;
};

export type CliBackendLiveEnvSnapshot = {
  configPath?: string;
  stateDir?: string;
  token?: string;
  skipChannels?: string;
  skipProviders?: string;
  skipGmail?: string;
  skipCron?: string;
  skipCanvas?: string;
  skipBrowserControl?: string;
  bundledPluginsDir?: string;
  minimalGateway?: string;
  anthropicApiKey?: string;
  anthropicApiKeyOld?: string;
};

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
  return resolveCliBackendLiveTest(providerId)?.defaultImageProbe === true;
}

export function shouldRunCliMcpProbe(providerId: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return resolveCliBackendLiveTest(providerId)?.defaultMcpProbe === true;
}

export function matchesCliBackendReply(text: string, expected: string): boolean {
  const normalized = text.trim();
  const target = expected.trim();
  return normalized === target || normalized === target.slice(0, -1);
}

export function withClaudeMcpConfigOverrides(args: string[], mcpConfigPath: string): string[] {
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
        timeoutMs: Math.min(remainingMs, 45_000),
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
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
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
    skipProviders: process.env.OPENCLAW_SKIP_PROVIDERS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipBrowserControl: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
    bundledPluginsDir: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
    minimalGateway: process.env.OPENCLAW_TEST_MINIMAL_GATEWAY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicApiKeyOld: process.env.ANTHROPIC_API_KEY_OLD,
  };
}

export function applyCliBackendLiveEnv(preservedEnv: ReadonlySet<string>): void {
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
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
  restoreEnvVar("OPENCLAW_SKIP_PROVIDERS", snapshot.skipProviders);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", snapshot.skipGmail);
  restoreEnvVar("OPENCLAW_SKIP_CRON", snapshot.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", snapshot.skipCanvas);
  restoreEnvVar("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", snapshot.skipBrowserControl);
  restoreEnvVar("OPENCLAW_BUNDLED_PLUGINS_DIR", snapshot.bundledPluginsDir);
  restoreEnvVar("OPENCLAW_TEST_MINIMAL_GATEWAY", snapshot.minimalGateway);
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
  const imageBase64 = renderCatFacePngBase64();
  const runIdImage = randomUUID();
  const imageProbe = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${runIdImage}-image`,
      // Route all providers through the same attachment pipeline. Claude CLI
      // still receives a local file path, but now via the runner code we
      // actually want to validate instead of an ad hoc prompt-only shortcut.
      message:
        "Best match for the image: lobster, mouse, cat, horse. " +
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
  assertLiveImageProbeReply(extractPayloadText(imageProbe?.result));
}

export async function verifyCliCronMcpProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();

  let createdJob: CronListJob | undefined;
  let lastCronText = "";

  for (let attempt = 0; attempt < 2 && !createdJob; attempt += 1) {
    const runIdMcp = randomUUID();
    const cronResult = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${runIdMcp}-mcp-${attempt}`,
        message: buildLiveCronProbeMessage({
          agent: params.providerId,
          argsJson: cronProbe.argsJson,
          attempt,
          exactReply: cronProbe.name,
        }),
        deliver: false,
      },
      { expectFinal: true },
    );
    if (cronResult?.status !== "ok") {
      throw new Error(`cron mcp probe failed: status=${String(cronResult?.status)}`);
    }
    lastCronText = extractPayloadText(cronResult?.result).trim();
    createdJob = await assertCronJobVisibleViaCli({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: cronProbe.name,
      expectedMessage: cronProbe.message,
    });
    if (!createdJob && attempt === 1) {
      throw new Error(
        `cron cli verify could not find job ${cronProbe.name}: reply=${JSON.stringify(lastCronText)}`,
      );
    }
  }

  if (!createdJob) {
    throw new Error(`cron cli verify did not create job ${cronProbe.name}`);
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
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
