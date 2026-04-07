import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  applyCliBackendLiveEnv,
  createBootstrapWorkspace,
  DEFAULT_CLAUDE_ARGS,
  DEFAULT_CLEAR_ENV,
  DEFAULT_CODEX_ARGS,
  getFreeGatewayPort,
  matchesCliBackendReply,
  parseImageMode,
  parseJsonStringArray,
  restoreCliBackendLiveEnv,
  shouldRunCliImageProbe,
  snapshotCliBackendLiveEnv,
  type SystemPromptReport,
  verifyClaudeCliCronMcpProbe,
  verifyCliBackendImageProbe,
  withMcpConfigOverrides,
  connectTestGatewayClient,
} from "./gateway-cli-backend.live-helpers.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CLI_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const CLI_RESUME = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE);
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const DEFAULT_MODEL = "claude-cli/claude-sonnet-4-6";
const CLI_BACKEND_LIVE_TIMEOUT_MS = 420_000;

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
      const previousEnv = snapshotCliBackendLiveEnv();

      clearRuntimeConfigSnapshot();
      applyCliBackendLiveEnv(preservedEnv);

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
            models: { [modelKey]: {} },
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
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      });

      try {
        const sessionKey = "agent:dev:live-cli-backend";
        const nonce = randomBytes(3).toString("hex").toUpperCase();
        const payload = await client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${randomUUID()}`,
            message:
              providerId === "codex-cli"
                ? `Please include the token CLI-BACKEND-${nonce} in your reply.`
                : `Reply with exactly: CLI backend OK ${nonce}.`,
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
          const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
          const resumePayload = await client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${randomUUID()}`,
              message:
                providerId === "codex-cli"
                  ? `Please include the token CLI-RESUME-${resumeNonce} in your reply.`
                  : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`,
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
          await verifyCliBackendImageProbe({
            client,
            providerId,
            sessionKey,
            tempDir,
            bootstrapWorkspace,
          });
        }

        if (providerId === "claude-cli") {
          await verifyClaudeCliCronMcpProbe({
            client,
            sessionKey,
            port,
            token,
            env: process.env,
          });
        }
      } finally {
        clearRuntimeConfigSnapshot();
        await client.stopAndWait();
        await server.close();
        await fs.rm(tempDir, { recursive: true, force: true });
        restoreCliBackendLiveEnv(previousEnv);
      }
    },
    CLI_BACKEND_LIVE_TIMEOUT_MS,
  );
});
