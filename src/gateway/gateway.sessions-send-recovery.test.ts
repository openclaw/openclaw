import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { ChatPendingInputsPage } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "../../test/helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import {
  printRecoveryFailureDiagnostics,
  RECOVERY_PROBE_ID,
  writeRecoveryDiagnosticProbe,
} from "./gateway.sessions-send-recovery.diagnostics.test-support.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Real public chat.send/sessions_send, provider socket, and cold Gateway process restarts.
// The provider holds queued turns and proves steering persistence before restart.
it.for(["SIGTERM", "SIGKILL"] as const)(
  "recovers accepted chat and peer inputs once, in FIFO order, after %s",
  { timeout: 240_000 },
  async (shutdownSignal, test) => {
    await runQaGatewayTestFixture(test, async ({ signal, verifyCleanup }) => {
      const observed: string[] = [];
      const accepted = new Map<string, string>();
      const target = "agent:main:dashboard:peer-target";
      const steerTarget = "agent:main:dashboard:steer-target";
      const parallelTargets = Array.from(
        { length: 3 },
        (_, index) => `agent:main:dashboard:parallel-${index}`,
      );
      const expectedParallel = parallelTargets.map((_, index) =>
        [1, 2].map((ordinal) => `PARALLEL_INPUT_${index}_${ordinal}`),
      );
      const waitFor = (assertion: () => void, timeout = 30_000) =>
        vi.waitFor(assertion, { timeout });
      const parallelHeld = new Set<number>();
      const parallelResponses = new Map<number, ServerResponse>();
      const parallelObserved: string[][] = parallelTargets.map(() => []);
      let hold = true;
      let held = false;
      let recoveredThemeCalls = 0;
      let steerResponse: ServerResponse | undefined;
      let steerReleased = false;
      let steerToolStarted = false;
      let steerContinuations = 0;
      let recoveredResponse: ServerResponse | undefined;
      const recoveredResponseReady = createDeferred();
      const parallelResponsesReady = createDeferred();
      const reply = (response: ServerResponse, text = "RECEIVED") =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      const releaseHeldResponse = (response: ServerResponse | undefined) => {
        if (!response || response.destroyed || response.writableEnded) {
          return;
        }
        reply(response);
      };
      const continueSteer = (response: ServerResponse) => {
        // Keep the receiver alive while the sender finishes asynchronous admission.
        expect(++steerContinuations).toBeLessThanOrEqual(8);
        writeToolCall(response, "session_status", {});
      };
      const providerServer = createServer((request, response) => {
        void (async () => {
          const raw = await readRequestText(request);
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
          const parallelHold = text.match(/HOLD_PARALLEL_([0-9]+)/u);
          if (hold && parallelHold) {
            parallelHeld.add(Number(parallelHold[1]));
            return;
          }
          const parallelInput = text.match(/PARALLEL_INPUT_([0-9]+)_([0-9]+)/u);
          if (parallelInput) {
            const index = Number(parallelInput[1]);
            parallelObserved[index]!.push(parallelInput[0]);
            if (parallelInput[2] === "1") {
              parallelResponses.set(index, response);
              if (parallelResponses.size === parallelTargets.length) {
                parallelResponsesReady.resolve();
              }
              return;
            }
          }
          const sendMarker = text.match(
            /SEND_(STEER_UPDATE|PEER_UPDATE_[0-9]+|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE|ARCHIVED_SOURCE_UPDATE)/u,
          )?.[1];
          if (sendMarker) {
            if (outputIndex > userIndex) {
              const output = JSON.parse(input[outputIndex]!.output!) as {
                status?: string;
                runId?: string;
                targetDisposition?: string;
              };
              expect(output.status, JSON.stringify(output)).toBe("accepted");
              expect(typeof output.runId).toBe("string");
              if (sendMarker === "STEER_UPDATE") {
                expect(output.targetDisposition).toBe("steered");
              }
              accepted.set(sendMarker, output.runId!);
              reply(response, "SENT");
            } else {
              expect(body.tools?.some((tool) => tool.name === "sessions_send")).toBe(true);
              writeToolCall(response, "sessions_send", {
                sessionKey: sendMarker === "STEER_UPDATE" ? steerTarget : target,
                message: sendMarker,
                timeoutSeconds: 0,
                ...(sendMarker === "STEER_UPDATE" ? { mode: "steer" } : {}),
              });
            }
            return;
          }
          if (text.includes("HOLD_STEER")) {
            if (steerReleased) {
              continueSteer(response);
            } else {
              steerResponse = response;
            }
            return;
          }
          if (hold && text.includes("HOLD_TARGET")) {
            held = true;
            return;
          }
          const marker = text
            .match(
              /PEER_UPDATE_[0-9]+|CHAT_UPDATE_[0-9]+|CANCELLED_CHAT|CANCELLED_UPDATE|RESET_SOURCE_UPDATE|REVOKED_UPDATE|ARCHIVED_SOURCE_UPDATE/gu,
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
          if (!hold && marker === "CHAT_UPDATE_1" && !recoveredResponse) {
            recoveredResponse = response;
            recoveredResponseReady.resolve();
            return;
          }
          reply(response);
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
        gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
        gatewayArgs: ["--profile", profile],
        env: {
          VITEST: undefined,
          NODE_ENV: "production",
          OPENCLAW_PROFILE: profile,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        },
      });
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      const request = <T = Record<string, unknown>>(method: string, params?: unknown) =>
        client!.request<T>(method, params, { signal });
      const deviceIdentity = generateStoredDeviceIdentity();
      const connect = () =>
        acquireGatewayTestClient(
          {
            deviceIdentity,
            env: gateway.state.env,
            url: gateway.url,
            token: gateway.gatewayToken,
            clientName: "test",
            mode: "test",
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            // Reconnect with explicit credentials; this fixture has no local token cache.
            hostDeps: {
              loadDeviceAuthToken: () => null,
              storeDeviceAuthToken: () => {},
              clearDeviceAuthToken: () => {},
            },
            caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
            onEvent: (event) => {
              const payload = asOptionalRecord(event.payload);
              const data = asOptionalRecord(payload?.data);
              if (
                event.event === "agent" &&
                payload?.stream === "tool" &&
                data?.phase === "start" &&
                data.name === "sessions_send" &&
                asOptionalRecord(data.args)?.message === "STEER_UPDATE"
              ) {
                steerToolStarted = true;
              }
            },
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
      const chatRequests: Array<{
        sessionKey: string;
        message: string;
        idempotencyKey: string;
        queueMode: "followup";
      }> = [];
      const cancelledChatId = randomUUID();
      const expectedDelivery = expectedUpdates.flatMap((message, i) => [
        message,
        `CHAT_UPDATE_${i + 1}`,
      ]);
      type History = {
        messages: Array<{
          role?: string;
          content?: unknown;
          provenance?: { kind?: string; sourceTool?: string };
        }>;
        pendingInputs: ChatPendingInputsPage;
      };
      const history = (sessionKey = target) => request<History>("chat.history", { sessionKey });
      const expectPersistedSteer = async () => {
        const result = await history(steerTarget);
        expect(
          result.messages.filter(
            (message) =>
              message.role === "assistant" &&
              message.provenance?.kind === "inter_session" &&
              message.provenance.sourceTool === "sessions_send" &&
              JSON.stringify(message.content).includes("STEER_UPDATE"),
          ),
        ).toHaveLength(1);
      };
      const start = (sessionKey: string, message: string) =>
        request<{ runId: string }>("agent", {
          agentId: "main",
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
      const archivedSource = "agent:main:dashboard:archived-source";
      let restarting: Promise<void> | undefined;
      try {
        const diagnosticPlugin = gateway.state.path("recovery-proof");
        await writeRecoveryDiagnosticProbe(diagnosticPlugin);
        const provider = buildMockOpenAiResponsesProvider(baseUrl);
        const config = {
          diagnostics: { enabled: true },
          logging: { level: "debug", file: gateway.state.path("gateway.log") },
          gateway: {
            port: gateway.port,
            auth: { mode: "token", token: gateway.gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            defaults: {
              maxConcurrent: 8,
              workspace: gateway.state.workspaceDir,
              skipBootstrap: true,
              utilityModel: "",
              skills: [],
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
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            sessions: { visibility: "all" },
          },
          plugins: {
            slots: { memory: "none" },
            load: { paths: [diagnosticPlugin] },
            entries: { [RECOVERY_PROBE_ID]: { enabled: true } },
          },
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(config);
        await gateway.startGateway();
        client = await connect();
        const requester = await request<{ profile: { id: string } }>("users.self", {});
        const preferencesBefore = await request("users.prefs.get", { keys: ["ui.themeMode"] });
        expect(preferencesBefore).toEqual({ status: "ok", entries: {} });
        const sessionIds = new Map<string, string>();
        for (const key of [
          target,
          steerTarget,
          source,
          resetSource,
          revokedSource,
          archivedSource,
          ...parallelTargets,
        ]) {
          const created = await request<{ sessionId: string }>("sessions.create", {
            key,
            agentId: "main",
            communication: { send: "always", receive: "always" },
          });
          sessionIds.set(key, created.sessionId);
        }
        await start(target, "HOLD_TARGET");
        await waitFor(() => expect(held).toBe(true));
        const send = async (from: string, message: string) => {
          const sender = await start(from, "SEND_" + message);
          await request("agent.wait", { runId: sender.runId, timeoutMs: 30_000 });
          await waitFor(() => expect(accepted.has(message)).toBe(true));
          return accepted.get(message);
        };
        await start(steerTarget, "HOLD_STEER");
        await waitFor(() => expect(steerResponse).toBeDefined());
        const steering = send(source, "STEER_UPDATE");
        await Promise.race([
          waitFor(() => expect(steerToolStarted).toBe(true)),
          steering.then(() => {
            throw new Error("Steering acknowledged before the held input could be committed");
          }),
        ]);
        expect(accepted.has("STEER_UPDATE")).toBe(false);
        steerReleased = true;
        continueSteer(steerResponse!);
        await steering;
        await expectPersistedSteer();
        for (const [index, key] of parallelTargets.entries()) {
          await start(key, `HOLD_PARALLEL_${index}`);
          await waitFor(() => expect(parallelHeld.has(index)).toBe(true));
          for (const ordinal of [1, 2]) {
            await request("chat.send", {
              sessionKey: key,
              message: `PARALLEL_INPUT_${index}_${ordinal}`,
              idempotencyKey: randomUUID(),
              queueMode: "followup",
            });
          }
        }
        for (const message of expectedUpdates) {
          await send(source, message);
          const input = {
            sessionKey: target,
            message: `  CHAT_UPDATE_${chatRequests.length + 1}  `,
            idempotencyKey: randomUUID(),
            queueMode: "followup" as const,
          };
          chatRequests.push(input);
          const admitted = await request<{ runId: string }>("chat.send", input);
          expect(admitted.runId).toBe(input.idempotencyKey);
        }
        const cancelled = await send(source, "CANCELLED_UPDATE");
        await send(resetSource, "RESET_SOURCE_UPDATE");
        await send(revokedSource, "REVOKED_UPDATE");
        await send(archivedSource, "ARCHIVED_SOURCE_UPDATE");
        await request("chat.send", {
          sessionKey: target,
          message: "CANCELLED_CHAT",
          idempotencyKey: cancelledChatId,
          queueMode: "followup",
        });
        const before = await history();
        expect(before.pendingInputs.items).toHaveLength(15);
        expect(JSON.stringify(before)).not.toContain("chatInputRecovery");
        await request("chat.abort", { sessionKey: target, runId: cancelledChatId });
        expect(JSON.stringify(before)).not.toContain("sessionSendDelivery");
        await request("chat.abort", { sessionKey: target, runId: cancelled });
        await request("sessions.reset", { key: resetSource });
        await request("sessions.patch", {
          key: revokedSource,
          communication: { send: "never", receive: "always" },
        });
        await request("sessions.patch", {
          key: archivedSource,
          archived: true,
          expectedSessionId: sessionIds.get(archivedSource),
        });
        const firstPid = gateway.child?.pid;
        await client.stopAndWait();
        client = undefined;
        // Both variants stop only the isolated process. SIGKILL cannot run cleanup.
        const oldProcess = gateway.child;
        if (!oldProcess) {
          throw new Error("Owned Gateway process unavailable");
        }
        const closed = once(oldProcess, "close", { signal });
        expect(oldProcess.kill(shutdownSignal)).toBe(true);
        expect(await closed, gateway.logs()).toEqual(
          shutdownSignal === "SIGKILL" ? [null, "SIGKILL"] : [0, null],
        );
        await gateway.stopGateway();
        if (shutdownSignal === "SIGTERM") {
          expect(gateway.logs()).toContain("received SIGTERM");
          expect(oldProcess?.signalCode).not.toBe("SIGKILL");
        }
        hold = false;
        const beforeRestartLogs = gateway.logs().length;
        const startup = (restarting = gateway.startGateway());
        const awaitRecovery = <T>(gate: PromiseLike<T>) =>
          withinTest(Promise.race([gate, startup.then(() => gate)]), signal);
        await awaitRecovery(recoveredResponseReady.promise);
        // Startup may settle before or after held model calls; only its failure aborts waiting.
        // Require successful startup after releasing the provider responses below.
        // A held turn in one session must not keep other sessions from replaying.
        await awaitRecovery(parallelResponsesReady.promise);
        expect(parallelObserved).toEqual(
          parallelTargets.map((_, index) => [`PARALLEL_INPUT_${index}_1`]),
        );
        const recoveryTrace = () =>
          gateway
            .logs()
            .slice(beforeRestartLogs)
            .match(/startup (?:trace|phase): sidecars\.subagent-recovery ([0-9.]+)ms/u);
        await awaitRecovery(waitFor(() => expect(recoveryTrace()).not.toBeNull(), 10_000));
        for (const response of parallelResponses.values()) {
          releaseHeldResponse(response);
        }
        releaseHeldResponse(recoveredResponse);
        await startup;
        expect(gateway.child?.pid).not.toBe(firstPid);
        client = await connect();
        await expectPersistedSteer();
        // Stored text is trimmed; the recovery-to-fresh-admission handoff must
        // still dedupe the original request identity immediately after readiness.
        const handoffRetry = await request<{ runId: string }>("chat.send", chatRequests[0]);
        expect(handoffRetry.runId).toBe(chatRequests[0]!.idempotencyKey);
        await vi.waitFor(() => expect(observed).toEqual(expectedDelivery), {
          timeout: 60_000,
          interval: 200,
        });
        await waitFor(() => expect(parallelObserved).toEqual(expectedParallel), 60_000);
        for (const [index, key] of parallelTargets.entries()) {
          const parallelHistory = await history(key);
          expect(parallelHistory.pendingInputs.items).toEqual([]);
          for (const ordinal of [1, 2]) {
            expect(
              parallelHistory.messages.filter(
                (message) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes(`PARALLEL_INPUT_${index}_${ordinal}`),
              ),
            ).toHaveLength(1);
          }
        }
        await waitFor(() =>
          expect(gateway.logs()).toContain("Session delivery recovery blocked for "),
        );
        expect(recoveredThemeCalls).toBe(1);
        expect(await request("users.self", {})).toMatchObject({
          profile: { id: requester.profile.id },
        });
        // Read the exact original person's durable effect independently of model output.
        expect(await request("users.prefs.get", { keys: ["ui.themeMode"] })).toEqual({
          status: "ok",
          entries: { "ui.themeMode": "dark" },
        });
        // Reconnect/browser retries keep the original identity and cannot execute twice.
        for (const input of chatRequests) {
          const replay = await request<{ runId: string }>("chat.send", input);
          expect(replay.runId).toBe(input.idempotencyKey);
        }
        const after = await history();
        expect(JSON.stringify(after)).not.toContain("chatInputRecovery");
        // History retains the cancelled receipt; only permission failures can replay.
        expect(after.pendingInputs.items.map(({ state, runId }) => [state, runId])).toEqual([
          ["cancelled", accepted.get("RESET_SOURCE_UPDATE")],
          ["interrupted", accepted.get("REVOKED_UPDATE")],
          ["cancelled", accepted.get("ARCHIVED_SOURCE_UPDATE")],
          ["cancelled", cancelledChatId],
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
        await waitFor(() =>
          expect(
            gateway.logs().split("Session delivery recovery blocked for ").length,
          ).toBeGreaterThan(previousRecoveryWarnings),
        );
        expect(gateway.logs().split("Session delivery endpoint was replaced")).toHaveLength(
          previousReplacementWarnings,
        );
        const finalHistory = JSON.stringify(await history());
        await expectPersistedSteer();
        expect(finalHistory).not.toContain("sessionSendDelivery");
        expect(finalHistory).toContain(
          "current session permissions do not allow automatic delivery",
        );
        expect(finalHistory).toContain("session was reset or replaced");
        expect(finalHistory).not.toContain(`From ${archivedSource}`);
        expect(gateway.logs()).not.toContain('"archived":true');
        expect(observed).toEqual(expectedDelivery);
        expect(parallelObserved).toEqual(expectedParallel);
      } catch (error) {
        await printRecoveryFailureDiagnostics({
          client,
          databasePath: path.join(gateway.state.agentDir("main"), "openclaw-agent.sqlite"),
          sessionKey: target,
          runId: chatRequests.at(-1)?.idempotencyKey,
          frames: [],
          restartedLogs: gateway.logs(),
          startupSnapshot: undefined,
          logPath: gateway.state.path("gateway.log"),
          markers: {},
        }).catch(() => console.error("[session-recovery-failure] diagnostics unavailable"));
        throw error;
      } finally {
        for (const response of parallelResponses.values()) {
          releaseHeldResponse(response);
        }
        releaseHeldResponse(recoveredResponse);
        await restarting?.catch(() => undefined);
        await client?.stopAndWait();
        await gateway.cleanup();
        await closeProvider(providerServer);
      }
    });
  },
);
