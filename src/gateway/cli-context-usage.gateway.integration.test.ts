import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { testing as cliBackends } from "../agents/cli-backends.test-support.js";
import { claudeStreamEvent, claudeTextDelta } from "../agents/cli-output.test-helpers.js";
import type { CliBackendExecute } from "../plugins/cli-backend.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "./test-helpers.env.js";

afterEach(() => {
  cliBackends.resetDepsForTest();
  return resetGatewayTestState();
});

it(
  "shows measured CLI context through sessions.list before the result arrives",
  { timeout: 120_000 },
  async () => {
    await withOpenClawTestState(
      { label: "cli-context", env: createAuthorityGatewayTestEnv() },
      async (state) => {
        const key = "agent:main:cli-context";
        const model = "anthropic/claude-sonnet-4-6";
        const token = "synthetic-cli-context-token";
        const gateway = await startGatewayWithClient({
          token,
          scopes: ["operator.admin"],
          configPath: state.configPath,
          cfg: {
            gateway: { mode: "local", auth: { mode: "token", token } },
            diagnostics: { enabled: false },
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model,
                models: { [model]: { agentRuntime: { id: "claude-cli" } } },
              },
            },
            plugins: { enabled: false },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        try {
          await gateway.server.startupSettled;
          const row = async () =>
            (
              await gateway.client.request<SessionsListResult>("sessions.list", {
                includeUnknown: true,
              })
            ).sessions.find((entry) => entry.key === key);
          const observed: Array<number | undefined> = [];
          let turnOffset = 0;
          const before: Array<number | undefined> = [];
          const execute: CliBackendExecute = async function* () {
            before.push((await row())?.totalTokens);
            for (const [index, cacheRead] of [19_288, 28_503].entries()) {
              const id = "parent-" + index;
              const usage = {
                input_tokens: 10,
                cache_read_input_tokens: cacheRead + turnOffset,
                output_tokens: 4,
              };
              yield claudeStreamEvent({ type: "message_start", message: { id, usage } });
              yield claudeTextDelta("Progress " + index);
              // The transport requests the next record only after consuming the preceding records.
              // Withhold the assistant snapshot and terminal result while the public reader polls.
              const expected = 14 + cacheRead + turnOffset;
              const until = Date.now() + 3_000;
              let sample = await row();
              while (sample?.totalTokens !== expected && Date.now() < until) {
                await delay(50);
                sample = await row();
              }
              observed.push(sample?.totalTokensFresh ? sample.totalTokens : undefined);
              yield {
                type: "assistant",
                message: {
                  id,
                  role: "assistant",
                  content: [{ type: "text", text: "Progress " + index }],
                  usage,
                },
              };
            }
            yield {
              type: "result",
              subtype: "success",
              result: "Done",
              usage: { input_tokens: 20, cache_read_input_tokens: 47_791, output_tokens: 8 },
            };
          };
          cliBackends.setDepsForTest({
            resolvePluginSetupCliBackend: () => undefined,
            resolveRuntimeCliBackends: () => [
              {
                id: "claude-cli",
                modelProvider: "anthropic",
                pluginId: "anthropic",
                config: {
                  command: process.execPath,
                  output: "jsonl",
                  jsonlDialect: "claude-stream-json",
                },
                prepareExecution: () => ({ execute, toolAvailabilityEnforced: true }),
                toolAvailabilityEnforcement: "prepare-execution",
              },
            ],
          });
          for (turnOffset of [0, 100]) {
            const result = await gateway.client.request<{ status: string }>(
              "agent",
              {
                sessionKey: key,
                message: "Show progress then finish.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { expectFinal: true, timeoutMs: 60000 },
            );
            expect(result.status).toBe("ok");
            expect(await row()).toMatchObject({
              key,
              totalTokens: 28_517 + turnOffset,
              totalTokensFresh: true,
            });
          }
          expect(before).toEqual([undefined, 28_517]);
          expect(observed).toEqual([19_302, 28_517, 19_402, 28_617]);
        } finally {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "CLI context test complete" });
        }
      },
    );
  },
);
