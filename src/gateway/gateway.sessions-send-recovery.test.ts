import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Real public sessions_send, real provider socket, cold Gateway process restart.
// A logical secondary agent shares the physical main store throughout recovery.
it.for(["managed", "SIGTERM", "SIGKILL"] as const)(
  "recovers accepted peer updates after %s once, in order, without reviving withdrawn authority",
  { timeout: 240_000 },
  async (mode, test) => {
    await runQaGatewayTestFixture(test, async ({ signal, verifyCleanup }) => {
      const observed: string[] = [];
      const accepted = new Map<string, string>();
      const requests: string[] = [];
      const attempted: string[] = [];
      const target = "agent:secondary:dashboard:peer-target";
      let hold = true;
      let held = false;
      let holdRecovery = mode === "SIGKILL";
      let recoveryHeld = false;
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          if (request.method !== "POST") {
            response.writeHead(200).end('{"data":[]}');
            return;
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = JSON.parse(raw) as {
            input?: Array<{ role?: string; content?: unknown; type?: string; output?: string }>;
            tools?: Array<{ name?: string }>;
          };
          const input = body.input ?? [];
          // Runtime context is another user-role block, not a submitted turn.
          const userIndex = input.findLastIndex(
            (item) =>
              item.role === "user" &&
              !JSON.stringify(item.content).includes("OpenClaw runtime context:"),
          );
          const text = JSON.stringify(input[userIndex]?.content ?? "");
          requests.push(text.slice(0, 500));
          const sendMarker = text.match(
            /SEND_(PEER_UPDATE_[0-9]+|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE)/u,
          )?.[1];
          if (sendMarker) {
            const outputIndex = input.findLastIndex((item) => item.type === "function_call_output");
            if (outputIndex > userIndex) {
              const output = JSON.parse(input[outputIndex]!.output!) as {
                status?: string;
                runId?: string;
              };
              expect(output.status, JSON.stringify(output)).toBe("accepted");
              expect(typeof output.runId).toBe("string");
              accepted.set(sendMarker, output.runId!);
              writeOpenAiResponsesText(response, {
                text: "SENT",
                messageId: randomUUID(),
                responseId: randomUUID(),
              });
            } else {
              expect(body.tools?.some((tool) => tool.name === "sessions_send")).toBe(true);
              const id = randomUUID();
              const args = JSON.stringify({
                sessionKey: target,
                message: sendMarker,
                timeoutSeconds: 0,
              });
              const item = {
                type: "function_call",
                id: "fc_" + id,
                call_id: "call_" + id,
                name: "sessions_send",
                arguments: args,
                status: "completed",
              };
              writeOpenAiResponsesSse(response, [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...item, arguments: "", status: "in_progress" },
                },
                {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: 0,
                  arguments: args,
                },
                { type: "response.output_item.done", output_index: 0, item },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_" + id,
                    status: "completed",
                    output: [item],
                    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                  },
                },
              ]);
            }
            return;
          }
          if (hold && text.includes("HOLD_TARGET")) {
            held = true;
            return;
          }
          // Orphan repair can carry the interrupted input into the next prompt.
          const markers: string[] =
            text.match(
              /PEER_UPDATE_[0-9]+|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE/gu,
            ) ?? [];
          attempted.push(...markers);
          if (holdRecovery && markers.includes("PEER_UPDATE_1")) {
            recoveryHeld = true;
            return;
          }
          observed.push(...markers);
          writeOpenAiResponsesText(response, {
            text: "RECEIVED",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        })().catch((error: unknown) => {
          console.error(
            "Synthetic provider fixture failed",
            String(error),
            request.headers["content-encoding"],
          );
          if (!response.destroyed) {
            response.writeHead(500).end();
          }
        });
      });
      await new Promise<void>((resolve) => {
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Provider did not bind");
      }
      const profile = `peer-recovery-${randomUUID()}`;
      const gateway = await createOpenClawTestInstance({
        name: "peer-input-recovery",
        cwd: process.cwd(),
        signal,
        verifyCleanup,
        stopTimeoutMs: 10_000,
        gatewayArgs: ["--profile", profile],
        env: {
          VITEST: undefined,
          NODE_ENV: "production",
          OPENCLAW_PROFILE: profile,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        },
      });
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      const connect = () =>
        acquireGatewayTestClient(
          {
            deviceIdentity: null,
            url: gateway.url,
            token: gateway.gatewayToken,
            clientName: "cli",
            mode: "cli",
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
          {
            timeoutMs: 30_000,
            timeoutMessage: "Recovery client connection timeout",
            closeMessage: "Recovery client closed",
            signal,
            verifyCleanup,
          },
        );
      const source = "agent:main:dashboard:peer-source";
      const resetSource = "agent:main:dashboard:reset-source";
      const revokedSource = "agent:main:dashboard:revoked-source";
      try {
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
        const config = {
          logging: { file: gateway.state.path("gateway.log") },
          gateway: {
            port: gateway.port,
            auth: { mode: "token", token: gateway.gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: gateway.state.workspaceDir,
              skipBootstrap: true,
              utilityModel: "",
              skills: [],
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef, fallbacks: [] },
              models: {
                [provider.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: {}, secondary: {} },
          },
          session: { store: gateway.state.path("shared-sessions.sqlite") },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
            },
          },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            sessions: { visibility: "all" },
            agentToAgent: { enabled: true },
          },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(config);
        await gateway.startGateway();
        client = await connect();
        for (const key of [source, resetSource, revokedSource, target]) {
          await client.request(
            "sessions.create",
            {
              key,
              agentId: key === target ? "secondary" : "main",
              communication: { send: "always", receive: "always" },
            },
            { signal },
          );
        }
        await client.request(
          "agent",
          {
            agentId: "secondary",
            sessionKey: target,
            message: "HOLD_TARGET",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { signal },
        );
        await vi.waitFor(() => expect(held).toBe(true), { timeout: 30_000 });
        const send = async (from: string, message: string) => {
          const sender = await client!.request<{ runId: string }>(
            "agent",
            {
              sessionKey: from,
              agentId: "main",
              message: "SEND_" + message,
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { signal },
          );
          await client!.request(
            "agent.wait",
            { runId: sender.runId, timeoutMs: 30_000 },
            { signal },
          );
          await vi.waitFor(() => expect(accepted.has(message)).toBe(true), { timeout: 30_000 });
          return accepted.get(message);
        };
        for (let i = 1; i <= 5; i++) {
          await send(source, `PEER_UPDATE_${i}`);
        }
        const cancelled = await send(source, "CANCELLED_UPDATE");
        await send(resetSource, "RESET_SOURCE_UPDATE");
        await send(revokedSource, "REVOKED_UPDATE");
        const before = await client.request<{ pendingInputs: ChatPendingInputsPage }>(
          "chat.history",
          { sessionKey: target },
          { signal },
        );
        expect(before.pendingInputs.items).toHaveLength(8);
        expect(JSON.stringify(before)).not.toContain("sessionSendDelivery");
        await client.request("chat.abort", { sessionKey: target, runId: cancelled }, { signal });
        await client.request("sessions.reset", { key: resetSource }, { signal });
        await client.request(
          "sessions.patch",
          { key: revokedSource, communication: { send: "never", receive: "always" } },
          { signal },
        );
        const firstPid = gateway.child?.pid;
        const restart = async (kind: typeof mode) => {
          const child = gateway.child;
          if (!child?.pid) {
            throw new Error("Owned Gateway process unavailable");
          }
          await client?.stopAndWait();
          client = undefined;
          const closed = once(child, "close", { signal });
          if (kind === "managed") {
            expect(
              writeGatewayRestartIntentSync({
                env: gateway.env,
                targetPid: child.pid,
                intent: { reason: "gateway.restart", force: true, waitMs: 100 },
              }),
            ).toBe(true);
          }
          expect(child.kill(kind === "SIGKILL" ? "SIGKILL" : "SIGTERM")).toBe(true);
          await closed;
          await gateway.startGateway();
          expect(gateway.child?.pid).not.toBe(child.pid);
          client = await connect();
        };
        hold = false;
        await restart(mode);
        expect(gateway.child?.pid).not.toBe(firstPid);
        if (mode === "SIGKILL") {
          await vi.waitFor(() => expect(recoveryHeld).toBe(true), { timeout: 30_000 });
          // The successor accepted the input but has not completed its provider turn.
          holdRecovery = false;
          await restart("SIGKILL");
        }
        await vi.waitFor(
          () =>
            expect(observed).toEqual([
              "PEER_UPDATE_1",
              "PEER_UPDATE_2",
              "PEER_UPDATE_3",
              "PEER_UPDATE_4",
              "PEER_UPDATE_5",
            ]),
          { timeout: 60_000, interval: 200 },
        );
        // Explicit cancellation withdraws the row from display; the two blocked
        // source deliveries remain inspectable and were not sent to the model.
        const after = await vi.waitFor(
          async () => {
            const history = await client!.request<{ pendingInputs: ChatPendingInputsPage }>(
              "chat.history",
              { sessionKey: target },
              { signal },
            );
            expect(history.pendingInputs.items.map((item) => item.state)).toEqual([
              "interrupted",
              "interrupted",
            ]);
            const sessions = await client!.request<SessionsListResult>(
              "sessions.list",
              { agentId: "secondary" },
              { signal },
            );
            expect(sessions.sessions.find((session) => session.key === target)).toMatchObject({
              hasActiveRun: false,
            });
            return history;
          },
          { timeout: 30_000 },
        );
        expect(after.pendingInputs.items.map((item) => item.runId)).toEqual([
          accepted.get("RESET_SOURCE_UPDATE"),
          accepted.get("REVOKED_UPDATE"),
        ]);
        await client.stopAndWait();
        client = undefined;
        await gateway.stopGateway();
        // Per-input warnings precede the notice write; the final summary follows it.
        const previousRecoveryWarnings = gateway
          .logs()
          .split("Session delivery recovery blocked for ").length;
        await gateway.startGateway();
        client = await connect();
        await vi.waitFor(
          () =>
            expect(
              gateway.logs().split("Session delivery recovery blocked for ").length,
            ).toBeGreaterThan(previousRecoveryWarnings),
          { timeout: 30_000 },
        );
        const finalHistory = await client.request(
          "chat.history",
          { sessionKey: target },
          { signal },
        );
        expect(JSON.stringify(finalHistory)).not.toContain("sessionSendDelivery");
        expect(JSON.stringify(finalHistory)).toContain(
          "current session permissions do not allow automatic delivery",
        );
        expect(JSON.stringify(finalHistory)).toContain("session was reset, archived, or replaced");
        expect(JSON.stringify(finalHistory)).not.toContain(`- From ${source}:`);
        expect(observed).toEqual([
          "PEER_UPDATE_1",
          "PEER_UPDATE_2",
          "PEER_UPDATE_3",
          "PEER_UPDATE_4",
          "PEER_UPDATE_5",
        ]);
        expect(attempted).toEqual([
          ...(mode === "SIGKILL" ? ["PEER_UPDATE_1"] : []),
          "PEER_UPDATE_1",
          "PEER_UPDATE_2",
          "PEER_UPDATE_3",
          "PEER_UPDATE_4",
          "PEER_UPDATE_5",
        ]);
        console.info(
          JSON.stringify({
            proof: "peer-input-recovery",
            mode,
            firstPid,
            finalPid: gateway.child?.pid,
            observed,
          }),
        );
      } catch (error) {
        if (client) {
          console.error(
            "Recovery input states:",
            JSON.stringify(
              await client
                .request("chat.history", { sessionKey: target }, { signal })
                .catch(String),
            ),
          );
          for (const [marker, runId] of accepted) {
            console.error(
              "Recovery run:",
              marker,
              JSON.stringify(
                await client
                  .request("agent.wait", { runId, timeoutMs: 0 }, { signal })
                  .catch(String),
              ),
            );
          }
        }
        console.error("Synthetic provider user inputs:", JSON.stringify(requests));
        console.error(gateway.logs());
        throw error;
      } finally {
        await client?.stopAndWait();
        await gateway.cleanup();
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
    });
  },
);
