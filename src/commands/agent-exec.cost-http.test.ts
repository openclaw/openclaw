import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import "../agents/agent-command.js";
import {
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(["pinned", "ambient", "snapshot", "override"] as const)(
  "distinguishes unpriced, free, and paid runs from %s config in exec JSON",
  async (mode) => {
    const root = tempDirs.make("openclaw-agent-exec-cost-http-");
    const configPath = path.join(root, "openclaw.json");
    const model = "cost-fixture/test-model";
    await withServer(
      (request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          "data: " +
            JSON.stringify({
              id: "chatcmpl_cost_fixture",
              choices: [
                { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      },
      async (baseUrl) => {
        for (const [name, cost, expected] of [
          ["unpriced", undefined, undefined],
          ["free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0],
          ["paid", { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 }, 0.003],
        ] as const) {
          clearRuntimeConfigSnapshot();
          const config = {
            plugins: { enabled: false },
            env: { shellEnv: { enabled: false } },
            agents: {
              entries: { main: {} },
              defaults: {
                systemAgent: { agentId: "main" },
                model: { primary: model },
                models: { [model]: { agentRuntime: { id: "openclaw" } } },
                contextInjection: "never",
              },
            },
            tools: { deny: ["*"] },
            models: {
              providers: {
                "cost-fixture": {
                  api: "openai-completions",
                  apiKey: "synthetic-unused-key",
                  baseUrl: baseUrl + "/v1",
                  request: { allowPrivateNetwork: true },
                  models: [{ id: "test-model", name: "Cost fixture", cost }],
                },
              },
            },
          };
          const baseConfig = structuredClone(config);
          if (mode === "override") {
            baseConfig.models.providers["cost-fixture"].models = [
              { id: "test-model", name: "Cost fixture", cost: undefined },
            ];
          }
          await fs.writeFile(configPath, JSON.stringify(baseConfig));
          if (mode === "snapshot") {
            const snapshot = await createConfigIO({
              configPath,
              observe: false,
            }).readConfigFileSnapshot();
            expect(snapshot.valid).toBe(true);
            setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
            const provider = baseConfig.models.providers["cost-fixture"];
            await fs.writeFile(
              configPath,
              JSON.stringify({
                ...baseConfig,
                models: {
                  providers: {
                    "cost-fixture": {
                      ...provider,
                      models: [
                        {
                          ...provider.models[0],
                          cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
                        },
                      ],
                    },
                  },
                },
              }),
            );
          }
          await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
            const runtime = createTestRuntime();
            const result = await agentExecCommand(
              "Reply OK without tools.",
              {
                ...(mode === "pinned" || mode === "override" ? { config: configPath } : {}),
                ...(mode === "override"
                  ? { configOverride: [JSON.stringify({ models: config.models })] }
                  : {}),
                cwd: root,
                codeMode: "direct",
                thinking: "off",
                json: true,
              },
              runtime,
            );
            expect(result, name + ": " + JSON.stringify(result.envelope.error)).toMatchObject({
              exitCode: 0,
              envelope: { final: "OK" },
            });
            if (mode === "snapshot") {
              expect.soft(getRuntimeConfigSourceSnapshot(), name).toEqual(config);
            }
            const output = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
            expect(output.usage, name).toMatchObject({ input: 1000, output: 500, total: 1500 });
            if (expected === undefined) {
              expect.soft(output, name).not.toHaveProperty("costUsd");
              expect.soft(output.usage, name).not.toHaveProperty("cost");
            } else {
              expect.soft(output.costUsd, name).toBe(expected);
              expect.soft(output.usage.cost?.total, name).toBe(expected);
            }
          });
        }
      },
    );
  },
);
