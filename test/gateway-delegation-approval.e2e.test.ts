import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it.each([
  { scenario: "benign-exec-denied", allowExec: false, needsApproval: false },
  { scenario: "command-exec-denied", allowExec: false, needsApproval: true },
  { scenario: "command-exec-allowed", allowExec: true, needsApproval: true },
] as const)(
  "uses the spawned Gateway entry point for delegated config: $scenario",
  { timeout: 180_000 },
  async ({ scenario, allowExec, needsApproval }) => {
    const signal = AbortSignal.timeout(160_000);
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let issued = false;
    let ordinal = 0;
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(failed, async (request, response, body) => {
          expect(request.url).toBe("/v1/responses");
          const tools = restartToolNames(body);
          const input = JSON.stringify(body.input);
          const current = ++ordinal;
          if (tools.includes("openclaw") && input.includes("DELEGATED_CONFIG_ENTRY") && !issued) {
            issued = true;
            writeRestartToolCall(
              response,
              "delegate-entry",
              "openclaw",
              {
                message: needsApproval
                  ? "config set mcp.servers.demo.command node"
                  : "config set messages.ackReaction eyes",
              },
              current,
            );
            return;
          }
          writeOpenAiResponsesText(response, {
            text: "ENTRY_DONE",
            messageId: `msg_entry_${current}`,
            responseId: `resp_entry_${current}`,
          });
        }),
    });
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${reservation.claim.port}/v1`,
    );
    const instance = await createOpenClawTestInstance({
      name: `gateway-delegation-entry-${scenario}`,
      signal,
      startTimeoutMs: 120_000,
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    let client: GatewayClient | undefined;
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, failed.promise]), signal);
    await runQaGatewayFixture(
      async () => {
        await instance.state.writeConfig({
          update: { checkOnStart: false },
          browser: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          plugins: { enabled: false },
          ...restartModelConfig(provider, instance.state.workspaceDir),
          tools: {
            profile: "full",
            allow: allowExec ? ["openclaw", "exec"] : ["openclaw"],
            codeMode: { enabled: false },
            toolSearch: false,
            exec: { host: "gateway", security: "full", ask: "off" },
          },
          gateway: {
            mode: "local",
            controlUi: { enabled: false },
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
          },
        });
        const original = await readFile(instance.configPath, "utf8");
        await instance.startGateway();
        client = await connectRestartClient(instance, { mode: "backend" }, signal);
        await client.request(
          "chat.send",
          {
            sessionKey: `agent:main:delegation-entry-${scenario}`,
            message: needsApproval
              ? "DELEGATED_CONFIG_ENTRY: Add a local MCP server command."
              : "DELEGATED_CONFIG_ENTRY: Set the acknowledgement reaction to eyes.",
            idempotencyKey: `delegation-entry-${scenario}`,
          },
          { expectFinal: false },
        );
        if (!needsApproval) {
          await race(
            vi.waitFor(
              async () => {
                const config = JSON.parse(await readFile(instance.configPath, "utf8"));
                expect(config.messages?.ackReaction).toBe("eyes");
              },
              { timeout: 45_000 },
            ),
          );
          const approvals = await client.request<unknown[]>("openclaw.approval.list", {});
          expect(approvals).toEqual([]);
        } else {
          let approvalId: string | undefined;
          await race(
            vi.waitFor(
              async () => {
                expect(issued).toBe(true);
                const pendingConfig = JSON.parse(await readFile(instance.configPath, "utf8"));
                expect(pendingConfig.mcp?.servers?.demo).toBeUndefined();
                const approvals = await client!.request<Array<{ id: string }>>(
                  "openclaw.approval.list",
                  {},
                );
                expect(approvals).toHaveLength(1);
                approvalId = approvals[0]?.id;
              },
              { timeout: 45_000 },
            ),
          );
          expect(issued).toBe(true);
          expect(await readFile(instance.configPath, "utf8")).toBe(original);
          await client.request("approval.resolve", {
            id: approvalId,
            kind: "system-agent",
            decision: "deny",
          });
          await race(
            vi.waitFor(
              async () => {
                const approvals = await client!.request<unknown[]>("openclaw.approval.list", {});
                expect(approvals).toEqual([]);
              },
              { timeout: 45_000 },
            ),
          );
          expect(await readFile(instance.configPath, "utf8")).toBe(original);
        }
        expect(issued).toBe(true);
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      async () => {
        reservation.listener.closeAllConnections();
        await reservation.releaseListener();
        await reservation.claim.release();
      },
    );
  },
);
