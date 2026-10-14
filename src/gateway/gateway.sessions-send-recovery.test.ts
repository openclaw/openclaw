import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Real public sessions_send, real provider socket, cold Gateway process restart.
// The provider deliberately holds only the first target turn before restart.
it(
  "recovers accepted peer updates once, in order, without reviving withdrawn authority",
  { timeout: 240_000 },
  async (test) => {
    await runQaGatewayTestFixture(test, async ({ signal, verifyCleanup }) => {
      const observed: string[] = [];
      const accepted = new Map<string, string>();
      const target = "agent:main:dashboard:peer-target";
      let hold = true;
      let held = false;
      let recoveredThemeCalls = 0;
      const providerServer = createServer((request, response) => {
        void (async () => {
          const raw = await readProviderBody(request);
          if (request.method !== "POST") {
            response.writeHead(200).end('{"data":[]}');
            return;
          }
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
          const outputIndex = input.findLastIndex((item) => item.type === "function_call_output");
          const sendMarker = text.match(
            /SEND_(PEER_UPDATE_[0-9]+|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE|ARCHIVED_SOURCE_UPDATE)/u,
          )?.[1];
          if (sendMarker) {
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
              writeToolCall(response, "sessions_send", {
                sessionKey: target,
                message: sendMarker,
                timeoutSeconds: 0,
              });
            }
            return;
          }
          if (hold && text.includes("HOLD_TARGET")) {
            held = true;
            return;
          }
          const marker = text
            .match(
              /PEER_UPDATE_[0-9]+|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE|ARCHIVED_SOURCE_UPDATE/gu,
            )
            ?.at(-1);
          if (marker === "PEER_UPDATE_1") {
            if (outputIndex > userIndex) {
              const output: unknown = JSON.parse(input[outputIndex]!.output!);
              expect(output).toMatchObject({
                current: { mode: "dark", scope: "profile" },
                application: "saved",
              });
            } else {
              expect(body.tools?.some((tool) => tool.name === "theme")).toBe(true);
              recoveredThemeCalls++;
              expect(recoveredThemeCalls).toBe(1);
              writeToolCall(response, "theme", { action: "set", mode: "dark" });
              return;
            }
          }
          if (marker) {
            observed.push(marker);
          }
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
      const baseUrl = await listenProvider(providerServer);
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
      const expectedUpdates = Array.from({ length: 5 }, (_, i) => `PEER_UPDATE_${i + 1}`);
      const history = () =>
        client!.request<{ pendingInputs: ChatPendingInputsPage }>(
          "chat.history",
          { sessionKey: target },
          { signal },
        );
      const start = (sessionKey: string, message: string) =>
        client!.request<{ runId: string }>(
          "agent",
          { agentId: "main", sessionKey, message, deliver: false, idempotencyKey: randomUUID() },
          { signal },
        );
      const archivedSource = "agent:main:dashboard:archived-source";
      try {
        const provider = buildMockOpenAiResponsesProvider(baseUrl);
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
            entries: { main: {} },
          },
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
          },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(config);
        await gateway.startGateway();
        client = await connect();
        const requester = await client.request<{ profile: { id: string } }>(
          "users.self",
          {},
          { signal },
        );
        const preferencesBefore = await client.request(
          "users.prefs.get",
          { keys: ["ui.themeMode"] },
          { signal },
        );
        expect(preferencesBefore).toEqual({ status: "ok", entries: {} });
        const sessionIds = new Map<string, string>();
        for (const key of [target, source, resetSource, revokedSource, archivedSource]) {
          const created = await client.request<{ sessionId: string }>(
            "sessions.create",
            { key, agentId: "main", communication: { send: "always", receive: "always" } },
            { signal },
          );
          sessionIds.set(key, created.sessionId);
        }
        await start(target, "HOLD_TARGET");
        await vi.waitFor(() => expect(held).toBe(true), { timeout: 30_000 });
        const send = async (from: string, message: string) => {
          const sender = await start(from, "SEND_" + message);
          await client!.request(
            "agent.wait",
            { runId: sender.runId, timeoutMs: 30_000 },
            { signal },
          );
          await vi.waitFor(() => expect(accepted.has(message)).toBe(true), { timeout: 30_000 });
          return accepted.get(message);
        };
        for (const message of expectedUpdates) {
          await send(source, message);
        }
        const cancelled = await send(source, "CANCELLED_UPDATE");
        await send(resetSource, "RESET_SOURCE_UPDATE");
        await send(revokedSource, "REVOKED_UPDATE");
        await send(archivedSource, "ARCHIVED_SOURCE_UPDATE");
        const before = await history();
        expect(before.pendingInputs.items).toHaveLength(9);
        expect(JSON.stringify(before)).not.toContain("sessionSendDelivery");
        await client.request("chat.abort", { sessionKey: target, runId: cancelled }, { signal });
        await client.request("sessions.reset", { key: resetSource }, { signal });
        await client.request(
          "sessions.patch",
          { key: revokedSource, communication: { send: "never", receive: "always" } },
          { signal },
        );
        await client.request(
          "sessions.patch",
          {
            key: archivedSource,
            archived: true,
            expectedSessionId: sessionIds.get(archivedSource),
          },
          { signal },
        );
        const firstPid = gateway.child?.pid;
        await client.stopAndWait();
        client = undefined;
        // Kill only the isolated process: no graceful cleanup can manufacture persistence.
        expect(gateway.child?.kill("SIGKILL")).toBe(true);
        await gateway.stopGateway();
        hold = false;
        await gateway.startGateway();
        expect(gateway.child?.pid).not.toBe(firstPid);
        client = await connect();
        await vi.waitFor(() => expect(observed).toEqual(expectedUpdates), {
          timeout: 60_000,
          interval: 200,
        });
        await vi.waitFor(
          () => expect(gateway.logs()).toContain("Session delivery recovery blocked for "),
          { timeout: 30_000 },
        );
        expect(recoveredThemeCalls).toBe(1);
        expect(await client.request("users.self", {}, { signal })).toMatchObject({
          profile: { id: requester.profile.id },
        });
        // Read the exact original person's durable effect independently of model output.
        expect(
          await client.request("users.prefs.get", { keys: ["ui.themeMode"] }, { signal }),
        ).toEqual({ status: "ok", entries: { "ui.themeMode": "dark" } });
        const after = await history();
        // History retains the cancelled receipt; only permission failures can replay.
        expect(after.pendingInputs.items.map((item) => item.state)).toEqual([
          "cancelled",
          "interrupted",
          "cancelled",
        ]);
        expect(after.pendingInputs.items.map((item) => item.runId)).toEqual([
          accepted.get("RESET_SOURCE_UPDATE"),
          accepted.get("REVOKED_UPDATE"),
          accepted.get("ARCHIVED_SOURCE_UPDATE"),
        ]);
        await client.stopAndWait();
        client = undefined;
        await gateway.stopGateway();
        // Per-input warnings precede the notice write; the final summary follows it.
        const previousRecoveryWarnings = gateway
          .logs()
          .split("Session delivery recovery blocked for ").length;
        const previousReplacementWarnings = gateway
          .logs()
          .split("Session delivery endpoint was replaced").length;
        await gateway.startGateway();
        client = await connect();
        await vi.waitFor(
          () =>
            expect(
              gateway.logs().split("Session delivery recovery blocked for ").length,
            ).toBeGreaterThan(previousRecoveryWarnings),
          { timeout: 30_000 },
        );
        expect(gateway.logs().split("Session delivery endpoint was replaced")).toHaveLength(
          previousReplacementWarnings,
        );
        const finalHistory = JSON.stringify(await history());
        expect(finalHistory).not.toContain("sessionSendDelivery");
        expect(finalHistory).toContain(
          "current session permissions do not allow automatic delivery",
        );
        expect(finalHistory).toContain("session was reset or replaced");
        expect(finalHistory).not.toContain(`From ${archivedSource}`);
        expect(gateway.logs()).not.toContain('"archived":true');
        expect(observed).toEqual(expectedUpdates);
      } finally {
        await client?.stopAndWait();
        await gateway.cleanup();
        await closeProvider(providerServer);
      }
    });
  },
);
