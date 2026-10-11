import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { executeDeps } from "../agents/cli-runner/execute-deps.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStorePath } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it(
  "continues a legacy adopted node session without provisioning its cwd on the Gateway",
  { timeout: 90_000 },
  async () => {
    await withOpenClawTestState(
      {
        label: "chat-adopted-node-workspace",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        },
      },
      async (state) => {
        state.applyEnv();
        const token = "synthetic-adopted-node-workspace-token";
        const modelRef = "claude-cli/claude-sonnet-4-6";
        const nodeCwd = `/home/pr161183-node-user-${randomUUID()}/workspace`;
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: modelRef },
              models: { [modelRef]: {} },
              sandbox: { mode: "off" },
            },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: {
            enabled: true,
            allow: ["anthropic"],
            entries: { anthropic: { enabled: true } },
            slots: { memory: "none" },
          },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        const originalInvoke = executeDeps.invokeNodeClaudeCliRun;
        let invokedCwd: string | undefined;
        try {
          gateway = await startGatewayWithClient({
            cfg,
            configPath: state.configPath,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          const created = await gateway.client.request<{ key: string }>("sessions.create", {
            agentId: "main",
            execNode: "synthetic-ubuntu-node",
            cwd: nodeCwd,
            model: modelRef,
          });
          const storePath = resolveStorePath(undefined, { agentId: "main" });
          const updated = await updateSessionEntry(
            { agentId: "main", sessionKey: created.key, storePath },
            (entry) => ({
              ...entry,
              spawnedCwd: nodeCwd,
              cliBackendId: "claude-cli",
              cliSessionBinding: {
                sessionId: "synthetic-claude-thread",
                forceReuse: true,
                forkNextResume: true,
              },
            }),
            { skipMaintenance: true },
          );
          expect(updated).toMatchObject({
            execHost: "node",
            execNode: "synthetic-ubuntu-node",
            execCwd: nodeCwd,
            spawnedCwd: nodeCwd,
          });
          await expect(fs.access(nodeCwd)).rejects.toThrow();
          executeDeps.invokeNodeClaudeCliRun = async (request) => {
            invokedCwd = request.cwd;
            request.onProgress(
              [
                JSON.stringify({
                  type: "system",
                  subtype: "init",
                  session_id: "synthetic-claude-thread",
                }),
                JSON.stringify({
                  type: "result",
                  session_id: "synthetic-claude-thread",
                  result: "PONG",
                }),
                "",
              ].join("\n"),
            );
            return {
              ok: true,
              payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
            };
          };
          const run = await gateway.client.request<{ runId: string }>("chat.send", {
            sessionKey: created.key,
            message: "Reply exactly PONG",
            idempotencyKey: randomUUID(),
          });
          await expect(
            gateway.client.request(
              "agent.wait",
              { runId: run.runId, timeoutMs: 30_000 },
              { timeoutMs: 35_000 },
            ),
          ).resolves.toMatchObject({ status: "ok" });
          const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: created.key,
            limit: 20,
          });
          expect(JSON.stringify(history.messages)).toContain("PONG");
          expect(invokedCwd).toBe(nodeCwd);
          await expect(fs.access(nodeCwd)).rejects.toThrow();
        } finally {
          executeDeps.invokeNodeClaudeCliRun = originalInvoke;
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "test complete" });
          }
        }
      },
    );
  },
);
