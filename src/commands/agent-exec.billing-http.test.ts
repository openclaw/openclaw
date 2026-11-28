import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import "../agents/agent-command.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { agentExecCommand } from "./agent-exec.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("preserves request affordability without reducing output or resending through agent exec", async () => {
  const root = tempDirs.make("openclaw-agent-exec-billing-http-");
  const configPath = path.join(root, "openclaw.json");
  const requests: Record<string, unknown>[] = [];
  await withServer(
    (request, response) => {
      void (async () => {
        requests.push(JSON.parse(await text(request)) as Record<string, unknown>);
        response.writeHead(402, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: 402,
              message:
                "This request requires more credits, or fewer max_tokens. You requested up to 217003 tokens, but can only afford 134896.",
            },
          }),
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async (baseUrl) => {
      const model = "affordability-fixture/model";
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: { enabled: false },
          env: { shellEnv: { enabled: false } },
          agents: {
            defaults: {
              systemAgent: { agentId: "main" },
              model: { primary: model, fallbacks: [] },
              models: {
                [model]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 217003 } },
              },
            },
          },
          models: {
            providers: {
              "affordability-fixture": {
                api: "openai-completions",
                apiKey: "synthetic-unused-key",
                baseUrl: `${baseUrl}/v1`,
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "model",
                    name: "Affordability fixture",
                    reasoning: false,
                    contextWindow: 1000000,
                    maxTokens: 217003,
                    compat: { maxTokensField: "max_tokens" },
                  },
                ],
              },
            },
          },
        }),
      );
      const result = await agentExecCommand(
        "Reply briefly without tools.",
        {
          config: configPath,
          cwd: root,
          stateDir: root,
          codeMode: "direct",
          json: true,
        },
        createThrowingTestRuntime(),
      );
      expect(result.envelope.status).toBe("error");
      expect(JSON.stringify(result.envelope)).toContain("Reduce the maximum output tokens");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.max_tokens).toBe(217003);
    },
  );
});
