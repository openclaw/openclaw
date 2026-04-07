import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const execFileAsync = promisify(execFile);
const LIVE = isLiveTestEnabled();
const CLI_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const CLI_RESUME = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE);
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const DEFAULT_MODEL = "claude-cli/claude-sonnet-4-6";
const CLI_BACKEND_LIVE_TIMEOUT_MS = 420_000;
const CLI_GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CLAUDE_ARGS = [
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
const DEFAULT_CODEX_ARGS = [
  "exec",
  "--json",
  "--color",
  "never",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
];
const DEFAULT_CLEAR_ENV = [
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

function randomImageProbeCode(len = 6): string {
  // Chosen to avoid common OCR confusions in our 5x7 bitmap font.
  // Notably: 0↔8, B↔8, 6↔9, 3↔B, D↔0.
  // Must stay within the glyph set in `src/gateway/live-image-probe.ts`.
  const alphabet = "24567ACEF";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function parseJsonStringArray(name: string, raw?: string): string[] | undefined {
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

function parseImageMode(raw?: string): "list" | "repeat" | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "list" || trimmed === "repeat") {
    return trimmed;
  }
  throw new Error("OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE must be 'list' or 'repeat'.");
}

function shouldRunCliImageProbe(providerId: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return providerId === "claude-cli";
}

function matchesCliBackendReply(text: string, expected: string): boolean {
  const normalized = text.trim();
  const target = expected.trim();
  return normalized === target || normalized === target.slice(0, -1);
}

function withMcpConfigOverrides(args: string[], mcpConfigPath: string): string[] {
  const next = [...args];
  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  if (!next.includes("--mcp-config")) {
    next.push("--mcp-config", mcpConfigPath);
  }
  return next;
}

async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 40_000,
  });
}

type BootstrapWorkspaceContext = {
  expectedInjectedFiles: string[];
  workspaceDir: string;
  workspaceRootDir: string;
};

type SystemPromptReport = {
  injectedWorkspaceFiles?: Array<{ name?: string }>;
};

type CronListCliResult = {
  jobs?: Array<{
    id?: string;
    name?: string;
    sessionTarget?: string;
    agentId?: string | null;
    sessionKey?: string | null;
    payload?: { kind?: string; text?: string; message?: string };
  }>;
};

async function createBootstrapWorkspace(tempDir: string): Promise<BootstrapWorkspaceContext> {
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

async function runOpenClawCliJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
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

async function connectClient(params: { url: string; token: string }) {
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

async function connectClientOnce(params: { url: string; token: string; timeoutMs: number }) {
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

describeLive("gateway live (cli backend)", () => {
  it(
    "runs the agent pipeline against the local CLI backend",
    async () => {
      const preservedEnv = new Set(
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV,
        ) ?? [],
      );

      clearRuntimeConfigSnapshot();
      const previous = {
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
        skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
        skipCron: process.env.OPENCLAW_SKIP_CRON,
        skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        anthropicApiKeyOld: process.env.ANTHROPIC_API_KEY_OLD,
      };

      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      if (!preservedEnv.has("ANTHROPIC_API_KEY")) {
        delete process.env.ANTHROPIC_API_KEY;
      }
      if (!preservedEnv.has("ANTHROPIC_API_KEY_OLD")) {
        delete process.env.ANTHROPIC_API_KEY_OLD;
      }

      const token = `test-${randomUUID()}`;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      const port = await getFreeGatewayPort();

      const rawModel = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
      const parsed = parseModelRef(rawModel, "claude-cli");
      if (!parsed) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_MODEL must resolve to a CLI backend model. Got: ${rawModel}`,
        );
      }
      const providerId = parsed.provider;
      const modelKey = `${providerId}/${parsed.model}`;
      const enableCliImageProbe = shouldRunCliImageProbe(providerId);

      const providerDefaults =
        providerId === "claude-cli"
          ? {
              command: "claude",
              args: DEFAULT_CLAUDE_ARGS,
            }
          : providerId === "codex-cli"
            ? {
                command: "codex",
                args: DEFAULT_CODEX_ARGS,
                imageArg: "--image",
                imageMode: "repeat" as const,
              }
            : null;

      const cliCommand = process.env.OPENCLAW_LIVE_CLI_BACKEND_COMMAND ?? providerDefaults?.command;
      if (!cliCommand) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_COMMAND is required for provider "${providerId}".`,
        );
      }
      const baseCliArgs =
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_ARGS",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_ARGS,
        ) ?? providerDefaults?.args;
      if (!baseCliArgs || baseCliArgs.length === 0) {
        throw new Error(`OPENCLAW_LIVE_CLI_BACKEND_ARGS is required for provider "${providerId}".`);
      }
      const cliClearEnv =
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV,
        ) ?? (providerId === "claude-cli" ? DEFAULT_CLEAR_ENV : []);
      const filteredCliClearEnv = cliClearEnv.filter((name) => !preservedEnv.has(name));
      const preservedCliEnv = Object.fromEntries(
        [...preservedEnv]
          .map((name) => [name, process.env[name]])
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const cliImageArg =
        process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG?.trim() || providerDefaults?.imageArg;
      const cliImageMode =
        parseImageMode(process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE) ??
        providerDefaults?.imageMode;

      if (cliImageMode && !cliImageArg) {
        throw new Error(
          "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE requires OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG.",
        );
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-"));
      const bootstrapWorkspace =
        providerId === "claude-cli" ? await createBootstrapWorkspace(tempDir) : null;
      const disableMcpConfig = process.env.OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG !== "0";
      let cliArgs = baseCliArgs;
      if (providerId === "claude-cli" && disableMcpConfig) {
        const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
        await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
        cliArgs = withMcpConfigOverrides(baseCliArgs, mcpConfigPath);
      }

      const cfg: OpenClawConfig = {};
      const cfgWithCliBackends = cfg as OpenClawConfig & {
        agents?: {
          defaults?: {
            cliBackends?: Record<string, Record<string, unknown>>;
          };
        };
      };
      const existingBackends = cfgWithCliBackends.agents?.defaults?.cliBackends ?? {};
      const nextCfg = {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          port,
          auth: { mode: "token", token },
        },
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            ...(bootstrapWorkspace ? { workspace: bootstrapWorkspace.workspaceRootDir } : {}),
            model: { primary: modelKey },
            models: {
              [modelKey]: {},
            },
            cliBackends: {
              ...existingBackends,
              [providerId]: {
                command: cliCommand,
                args: cliArgs,
                clearEnv: filteredCliClearEnv.length > 0 ? filteredCliClearEnv : undefined,
                env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
                systemPromptWhen: providerId === "claude-cli" ? "first" : "never",
                ...(cliImageArg ? { imageArg: cliImageArg, imageMode: cliImageMode } : {}),
              },
            },
            sandbox: { mode: "off" },
          },
        },
      };
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });

      const client = await connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      });

      try {
        const sessionKey = "agent:dev:live-cli-backend";
        const runId = randomUUID();
        const nonce = randomBytes(3).toString("hex").toUpperCase();
        const message =
          providerId === "codex-cli"
            ? `Please include the token CLI-BACKEND-${nonce} in your reply.`
            : `Reply with exactly: CLI backend OK ${nonce}.`;
        const payload = await client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runId}`,
            message,
            deliver: false,
          },
          { expectFinal: true },
        );
        if (payload?.status !== "ok") {
          throw new Error(`agent status=${String(payload?.status)}`);
        }
        const text = extractPayloadText(payload?.result);
        if (providerId === "codex-cli") {
          expect(text).toContain(`CLI-BACKEND-${nonce}`);
        } else {
          const resultWithMeta = payload?.result as {
            meta?: { systemPromptReport?: SystemPromptReport };
          };
          expect(matchesCliBackendReply(text, `CLI backend OK ${nonce}.`)).toBe(true);
          expect(
            resultWithMeta.meta?.systemPromptReport?.injectedWorkspaceFiles?.map(
              (entry) => entry.name,
            ) ?? [],
          ).toEqual(expect.arrayContaining(bootstrapWorkspace?.expectedInjectedFiles ?? []));
        }

        if (CLI_RESUME) {
          const runIdResume = randomUUID();
          const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
          const resumeMessage =
            providerId === "codex-cli"
              ? `Please include the token CLI-RESUME-${resumeNonce} in your reply.`
              : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`;
          const resumePayload = await client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${runIdResume}`,
              message: resumeMessage,
              deliver: false,
            },
            { expectFinal: true },
          );
          if (resumePayload?.status !== "ok") {
            throw new Error(`resume status=${String(resumePayload?.status)}`);
          }
          const resumeText = extractPayloadText(resumePayload?.result);
          if (providerId === "codex-cli") {
            expect(resumeText).toContain(`CLI-RESUME-${resumeNonce}`);
          } else {
            expect(
              matchesCliBackendReply(resumeText, `CLI backend RESUME OK ${resumeNonce}.`),
            ).toBe(true);
          }
        }

        if (enableCliImageProbe) {
          const imageCode = randomImageProbeCode();
          const imageBase64 = renderCatNoncePngBase64(imageCode);
          const runIdImage = randomUUID();
          const imageFilePath = path.join(
            bootstrapWorkspace?.workspaceDir ?? tempDir,
            `probe-${runIdImage}.png`,
          );
          await fs.writeFile(imageFilePath, Buffer.from(imageBase64, "base64"));

          const imageProbe = await client.request(
            "agent",
            providerId === "claude-cli"
              ? {
                  sessionKey,
                  idempotencyKey: `idem-${runIdImage}-image`,
                  message:
                    `Image path: ${imageFilePath}\n` +
                    "Best match: lobster, mouse, cat, horse. " +
                    "Reply with one lowercase word only.",
                  deliver: false,
                }
              : {
                  sessionKey,
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

        if (providerId === "claude-cli") {
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
          let createdJob: CronListCliResult["jobs"] extends Array<infer T> ? T | undefined : never;
          let lastCronText = "";

          for (let attempt = 0; attempt < 2 && !createdJob; attempt += 1) {
            const runIdMcp = randomUUID();
            const cronProbe = await client.request(
              "agent",
              {
                sessionKey,
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
            const cronList = await runOpenClawCliJson<CronListCliResult>(
              [
                "cron",
                "list",
                "--all",
                "--json",
                "--url",
                `ws://127.0.0.1:${port}`,
                "--token",
                token,
              ],
              process.env,
            );
            createdJob =
              cronList.jobs?.find((job) => job.name === cronProbeName) ??
              cronList.jobs?.find((job) => job.payload?.message === cronProbeMessage);
            if (!createdJob && attempt === 1) {
              throw new Error(
                `cron cli verify could not find job ${cronProbeName}: reply=${JSON.stringify(lastCronText)} list=${JSON.stringify(cronList)}`,
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
          expect(createdJob?.sessionKey).toBe(sessionKey);
          expect(createdJob?.sessionTarget).toBe(`session:${sessionKey}`);
          if (createdJob?.id) {
            await runOpenClawCliJson(
              [
                "cron",
                "rm",
                createdJob.id,
                "--json",
                "--url",
                `ws://127.0.0.1:${port}`,
                "--token",
                token,
              ],
              process.env,
            );
          }
        }
      } finally {
        clearRuntimeConfigSnapshot();
        await client.stopAndWait();
        await server.close();
        await fs.rm(tempDir, { recursive: true, force: true });
        if (previous.configPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
        }
        if (previous.token === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
        }
        if (previous.skipChannels === undefined) {
          delete process.env.OPENCLAW_SKIP_CHANNELS;
        } else {
          process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
        }
        if (previous.skipGmail === undefined) {
          delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
        } else {
          process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
        }
        if (previous.skipCron === undefined) {
          delete process.env.OPENCLAW_SKIP_CRON;
        } else {
          process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
        }
        if (previous.skipCanvas === undefined) {
          delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
        } else {
          process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
        }
        if (previous.anthropicApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = previous.anthropicApiKey;
        }
        if (previous.anthropicApiKeyOld === undefined) {
          delete process.env.ANTHROPIC_API_KEY_OLD;
        } else {
          process.env.ANTHROPIC_API_KEY_OLD = previous.anthropicApiKeyOld;
        }
      }
    },
    CLI_BACKEND_LIVE_TIMEOUT_MS,
  );
});
