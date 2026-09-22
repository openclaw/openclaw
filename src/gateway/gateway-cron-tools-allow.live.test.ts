import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
  logLiveProgress,
} from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import type { CronJob } from "../cron/types.js";
import type { Message } from "../llm/types.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;
const MODEL_ID = "gpt-5.6-luna";
const MODEL_KEY = `openai/${MODEL_ID}`;
const RUN_TIMEOUT_MS = 300_000;

async function cliJson(instance: OpenClawTestInstance, args: string[]): Promise<unknown> {
  const result = await instance.cli(
    [...args, "--url", instance.url, "--token", instance.gatewayToken, "--json"],
    { timeoutMs: RUN_TIMEOUT_MS + 30_000 },
  );
  expect(result.code, `${args[0]} ${args[1]}: ${result.stderr}\n${result.stdout}`).toBe(0);
  return JSON.parse(result.stdout);
}

describeLive("cron tool allowlists through live harnesses", () => {
  it.each(["openclaw", "codex"] as const)(
    "%s preserves empty caps and applies edited names, groups, globs, and aliases",
    async (runtime) => {
      const instance = await createOpenClawTestInstance({
        name: `cron-tools-${runtime}`,
        env: {
          ...Object.fromEntries(
            listKnownProviderAuthEnvVarNames().map((name) => [name, undefined]),
          ),
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_BASE_URL: undefined,
          OPENAI_API_BASE: undefined,
          OPENCLAW_AGENT_RUNTIME: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      await runQaGatewayFixture(
        async () => {
          const workspace = instance.state.workspaceDir;
          const config: OpenClawConfig = {
            gateway: {
              mode: "local",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
              controlUi: { enabled: false },
            },
            plugins: {
              allow: ["codex"],
              entries: { codex: { enabled: true, config: { appServer: { mode: "yolo" } } } },
            },
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                timeoutSeconds: 240,
                thinkingDefault: "low",
                model: { primary: MODEL_KEY },
                models: { [MODEL_KEY]: { agentRuntime: { id: runtime } } },
                sandbox: { mode: "off" },
              },
              entries: { probe: { workspace } },
            },
            tools: { exec: { host: "gateway", security: "full", ask: "off" } },
            secrets: { providers: { default: { source: "env" } } },
            models: {
              mode: "merge",
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          };
          await instance.state.writeConfig(config);
          await instance.startGateway();

          const addArgs = [
            "cron",
            "add",
            "--name",
            `allowlist-${runtime}`,
            "--at",
            new Date(Date.now() + 86_400_000).toISOString(),
            "--agent",
            "probe",
            "--session",
            "isolated",
            "--no-deliver",
            "--keep-after-run",
            "--message",
            "Reply READY.",
          ];
          const defaultJob = (await cliJson(instance, addArgs)) as CronJob;
          expect(defaultJob.payload).toMatchObject({ toolsAllow: ["*"] });
          await cliJson(instance, ["cron", "rm", defaultJob.id]);

          const job = (await cliJson(instance, [...addArgs, "--tools", ""])) as CronJob;
          expect(job.payload).toMatchObject({ toolsAllow: [] });
          const sessionKeys = new Set<string>();
          for (const cap of ["", "read", "group:fs", "r*", "bash"]) {
            // The random contents never appear in the prompt or a previous run.
            const marker = `CRON_FILE_${randomUUID()}`;
            const file = path.join(workspace, `probe-${randomUUID()}.txt`);
            await fs.writeFile(file, `${marker}\n`);
            const instruction =
              cap === "bash"
                ? `Use the exec tool to run cat ${JSON.stringify(file)}.`
                : `Use the read tool to read ${JSON.stringify(file)}.`;
            const updated = (await cliJson(instance, [
              "cron",
              "edit",
              job.id,
              "--tools",
              cap,
              "--message",
              `${instruction} Reply with the file contents. If no tools are available, reply exactly NO_TOOLS.`,
            ])) as CronJob;
            expect(updated.payload).toMatchObject({ toolsAllow: cap ? [cap] : [] });

            const completed = (await cliJson(instance, [
              "cron",
              "run",
              job.id,
              "--wait",
              "--wait-timeout",
              "5m",
            ])) as { completed: boolean; status: string; run: CronRunLogEntry };
            expect(completed).toMatchObject({ completed: true, status: "ok" });
            expect(completed.run).toMatchObject({
              completionStatus: "succeeded",
              provider: "openai",
              model: MODEL_ID,
            });
            const sessionKey = completed.run.sessionKey;
            expect(sessionKey).toBeTypeOf("string");
            if (!sessionKey) {
              throw new Error("completed cron run has no session key");
            }
            expect(sessionKeys.has(sessionKey), "each isolated run needs fresh history").toBe(
              false,
            );
            sessionKeys.add(sessionKey);

            // Completed runs retire their alias; the stable row owns this transcript generation.
            const history = (await cliJson(instance, [
              "gateway",
              "call",
              "chat.history",
              "--params",
              JSON.stringify({ sessionKey: `agent:probe:cron:${job.id}`, limit: 100 }),
            ])) as {
              sessionId: string;
              messages: Message[];
              sessionInfo: { agentRuntime?: { id: string } };
            };
            expect(completed.run.sessionId).toBeTypeOf("string");
            expect(history.sessionId).toBe(completed.run.sessionId);
            expect(history.sessionInfo.agentRuntime?.id).toBe(runtime);
            const assistants = history.messages.filter((message) => message.role === "assistant");
            const calls = assistants.flatMap((message) =>
              message.content.filter((block) => block.type === "toolCall"),
            );
            const results = history.messages.filter((message) => message.role === "toolResult");
            expect(assistants.length, JSON.stringify(history)).toBeGreaterThan(0);
            if (cap === "") {
              expect(calls).toEqual([]);
              expect(results).toEqual([]);
              expect(JSON.stringify(assistants)).not.toContain(marker);
              expect(
                extractNonEmptyAssistantText(assistants.flatMap((message) => message.content)),
              ).toBe("NO_TOOLS");
            } else {
              const toolName = cap === "bash" ? "exec" : "read";
              const call = calls.find((entry) => entry.name === toolName);
              expect(call, `${runtime} cap ${cap}: expected ${toolName} call`).toBeDefined();
              const result = results.find((entry) => entry.toolCallId === call?.id);
              expect(result).toMatchObject({ toolName, isError: false });
              expect(JSON.stringify(result?.content)).toContain(marker);
            }
            logLiveProgress(`cron ${runtime}: tools=${JSON.stringify(cap)} passed (${MODEL_KEY})`);
          }
        },
        () => instance.cleanup(),
      );
    },
    6 * RUN_TIMEOUT_MS,
  );
});
