// Real process replacement covers the idle-session handoff that owner tests cannot prove.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { killProcessTree } from "../src/process/kill-tree.js";
import { getFileLockProcessStartTime } from "../src/shared/pid-alive.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const SESSION_KEY = "agent:main:background-process-restart";
const CANCEL_KEY = "agent:main:background-process-cancelled";
const REVOKED_KEY = "agent:main:background-process-revoked";
const REQUEST = "BACKGROUND_PROCESS_RESTART: start the background job and finish while it runs.";
const CANCEL_REQUEST = "BACKGROUND_PROCESS_CANCEL: start the background job, then kill it.";
const REVOKED_REQUEST =
  "BACKGROUND_PROCESS_REVOKED: start the background job and finish while it runs.";
const IDLE_FINAL = "BACKGROUND_PROCESS_WAITING";
const CANCEL_FINAL = "BACKGROUND_PROCESS_CANCELLED";
const RECOVERY_FINAL = "BACKGROUND_PROCESS_LOSS_RECONCILED";
const REVOKED_FINAL = "BACKGROUND_PROCESS_REVOKED_WRITE_DENIED";
const LOST_NOTICE = "process was lost when the Gateway restarted";

function writeTool(response: ServerResponse, name: string, args: object, ordinal: number) {
  const item = {
    type: "function_call",
    id: `fc_exec_${ordinal}`,
    call_id: `call_exec_${ordinal}`,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_exec_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startProvider(signal: AbortSignal, holdRecovery: boolean) {
  const firstRecovery = createDeferred<string>();
  const releaseRecovery = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const calls: Array<{
    kind: "start" | "cancel" | "recovery" | "revocation-start" | "revocation-recovery";
    input: string;
  }> = [];
  const processes = new Map<number, number>();
  const issuedExecs = new Set<string>();
  let cancelIssued = false;
  let revokedWriteIssued = false;
  let recovering = false;
  let ordinal = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          expect(request.url).toBe("/v1/responses");
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          const input = JSON.stringify(body.input);
          ordinal += 1;
          const text = (value: string) => {
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: `resp_${ordinal}`,
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: `msg_${ordinal}`,
                      role: "assistant",
                      content: [{ type: "output_text", text: value, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }),
              );
            } else {
              writeOpenAiResponsesText(response, {
                text: value,
                messageId: `msg_${ordinal}`,
                responseId: `resp_${ordinal}`,
              });
            }
          };
          const tool = (name: string, args: object) => {
            const nameOnWire = tools.includes(name) ? name : "dispatch_action";
            expect(tools).toContain(nameOnWire);
            writeTool(
              response,
              nameOnWire,
              nameOnWire === name ? args : { id: name, args },
              ordinal,
            );
          };
          if (tools.length === 0) {
            text("Synthetic background process restart");
            return;
          }
          if (recovering) {
            expect(input).not.toContain(CANCEL_REQUEST);
            expect(input.toLowerCase()).toContain(LOST_NOTICE.toLowerCase());
            expect(input.toLowerCase()).toContain("unknown");
            expect(input).toMatch(/check.*(?:side effects|state).*before.*re-?running/i);
            if (input.includes(REVOKED_REQUEST)) {
              calls.push({ kind: "revocation-recovery", input });
              if (!revokedWriteIssued) {
                revokedWriteIssued = true;
                tool("exec", { command: "printf 'unauthorized\\n' > revoked-effect" });
              } else {
                const results = Array.isArray(body.input)
                  ? body.input.filter(
                      (item) => isRecord(item) && item.type === "function_call_output",
                    )
                  : [];
                expect(JSON.stringify(results)).toContain("exec denied");
                text(REVOKED_FINAL);
              }
              return;
            }
            calls.push({ kind: "recovery", input });
            firstRecovery.resolve(input);
            if (holdRecovery && calls.filter((call) => call.kind === "recovery").length === 1) {
              await withinTest(releaseRecovery.promise, signal);
              if (response.destroyed) {
                return;
              }
            }
            text(RECOVERY_FINAL);
            return;
          }
          const cancelled = input.includes(CANCEL_REQUEST);
          const revoked = input.includes(REVOKED_REQUEST);
          const key = cancelled ? CANCEL_KEY : revoked ? REVOKED_KEY : SESSION_KEY;
          expect(input).toContain(cancelled ? CANCEL_REQUEST : revoked ? REVOKED_REQUEST : REQUEST);
          calls.push({
            kind: cancelled ? "cancel" : revoked ? "revocation-start" : "start",
            input,
          });
          if (!issuedExecs.has(key)) {
            issuedExecs.add(key);
            tool("exec", {
              command: `printf 'started\\n' >> ${cancelled ? "cancel-count" : revoked ? "revoked-count" : "exec-count"}; exec sleep 600`,
              background: true,
            });
            return;
          }
          const process = /Command still running \(session ([^,]+), pid (\d+)\)/.exec(input);
          if (process) {
            const pid = Number(process[2]);
            const startedAt = getFileLockProcessStartTime(pid);
            if (startedAt !== null) {
              processes.set(pid, startedAt);
            }
          }
          if (cancelled && !cancelIssued) {
            expect(process).not.toBeNull();
            cancelIssued = true;
            tool("process", { action: "kill", sessionId: process?.[1] });
          } else {
            expect(input).toContain(cancelled ? "Termination requested" : "Command still running");
            text(cancelled ? CANCEL_FINAL : IDLE_FINAL);
          }
        })().catch((error: unknown) => {
          if (!request.aborted) {
            failed.reject(error);
          }
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    calls,
    firstRecovery: firstRecovery.promise,
    failed: failed.promise,
    beginRecovery: () => {
      recovering = true;
    },
    releaseRecovery: () => releaseRecovery.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseRecovery.resolve();
          for (const [pid, startedAt] of processes) {
            if (getFileLockProcessStartTime(pid) === startedAt) {
              killProcessTree(pid, { force: true });
            }
          }
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

it.skipIf(process.platform === "win32").for(["managed", "SIGTERM", "SIGKILL"] as const)(
  "wakes an idle background-exec owner after %s and consumes the loss once",
  { timeout: 180_000 },
  async (mode, { signal }) => {
    const provider = await startProvider(signal, mode === "SIGKILL");
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
    const instance = await createOpenClawTestInstance({
      name: "gateway-background-process-restart",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
      config: {
        update: { checkOnStart: false },
        browser: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        plugins: { enabled: false },
        models: {
          mode: "replace",
          providers: {
            [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
          },
        },
        agents: {
          defaults: {
            model: { primary: model.modelRef },
            modelPolicy: { allow: [model.modelRef] },
            models: {
              [model.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
            heartbeat: { every: "0m" },
            skipBootstrap: true,
            skills: [],
            timeoutSeconds: 120,
          },
          entries: { main: {} },
        },
        tools: {
          allow: ["exec", "process"],
          codeMode: { enabled: false },
          exec: {
            host: "gateway",
            security: "full",
            ask: "off",
            notifyOnExit: true,
            notifyOnExitEmptySuccess: true,
          },
        },
      },
      env: {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      },
    });
    const config = asRecord(JSON.parse(await readFile(instance.configPath, "utf8")));
    const agents = asRecord(config.agents);
    await instance.state.writeConfig({
      ...config,
      agents: {
        ...agents,
        defaults: { ...asRecord(agents.defaults), workspace: instance.state.workspaceDir },
      },
    });
    let client: GatewayClient | undefined;
    const connect = () =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          clientName: "gateway-client",
          mode: "backend",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.path("device.sqlite"),
          }),
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "background-process restart client did not connect",
          closeMessage: "background-process restart client closed",
          signal,
        },
      );
    const waitForIdleFinal = async (sessionKey: string, final: string) => {
      await withinTest(
        Promise.race([
          vi.waitFor(
            async () => {
              const history = await client!.request("chat.history", { sessionKey });
              expect(JSON.stringify(history)).toContain(final);
              // History includes terminal persistence; the roster can already appear idle.
              expect(history).toMatchObject({ sessionInfo: { hasActiveRun: false } });
              const sessions = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(sessions.sessions.find((row) => row.key === sessionKey)).toMatchObject({
                hasActiveRun: false,
              });
            },
            { timeout: 30_000 },
          ),
          provider.failed,
        ]),
        signal,
      );
    };
    const restart = async (kind: typeof mode) => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
      const recoveryPasses = () =>
        (instance.logs().match(/startup trace: sidecars\.exec-recovery /g) ?? []).length;
      const priorRecoveryPasses = recoveryPasses();
      await client?.stopAndWait();
      client = undefined;
      const closed = once(child, "close");
      if (kind === "managed") {
        expect(
          writeGatewayRestartIntentSync({
            env: instance.env,
            targetPid: child.pid,
            intent: { reason: "gateway.restart", force: true, waitMs: 100 },
          }),
        ).toBe(true);
      }
      expect(child.kill(kind === "SIGKILL" ? "SIGKILL" : "SIGTERM")).toBe(true);
      await withinTest(closed, signal);
      await instance.startGateway();
      expect(instance.child?.pid).not.toBe(child.pid);
      client = await connect();
      await withinTest(
        Promise.race([
          vi.waitFor(() => expect(recoveryPasses()).toBeGreaterThan(priorRecoveryPasses), {
            timeout: 30_000,
          }),
          provider.failed,
        ]),
        signal,
      );
    };
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connect();
        for (const [sessionKey, message, final] of [
          [CANCEL_KEY, CANCEL_REQUEST, CANCEL_FINAL],
          [SESSION_KEY, REQUEST, IDLE_FINAL],
          [REVOKED_KEY, REVOKED_REQUEST, IDLE_FINAL],
        ] as const) {
          await client.request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            permissionMode: "full",
          });
          await client.request(
            "chat.send",
            { sessionKey, message, idempotencyKey: sessionKey },
            { expectFinal: false },
          );
          await waitForIdleFinal(sessionKey, final);
        }
        await client.request("sessions.patch", { key: REVOKED_KEY, permissionMode: "read-only" });
        expect(await readFile(path.join(instance.state.workspaceDir, "exec-count"), "utf8")).toBe(
          "started\n",
        );
        provider.beginRecovery();
        await restart(mode);
        await withinTest(Promise.race([provider.firstRecovery, provider.failed]), signal);
        await waitForIdleFinal(REVOKED_KEY, REVOKED_FINAL);
        if (mode === "SIGKILL") {
          // The first successor has adopted the notice and is waiting on its model response.
          await restart("SIGKILL");
          provider.releaseRecovery();
        }
        await waitForIdleFinal(SESSION_KEY, RECOVERY_FINAL);
        expect(provider.calls.filter((call) => call.kind === "revocation-recovery")).toHaveLength(
          2,
        );
        await expect(
          readFile(path.join(instance.state.workspaceDir, "revoked-effect")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        // Display history hides exec inputs; count notices at the model boundary.
        const recoveries = provider.calls.filter((call) => call.kind === "recovery");
        for (const recovery of recoveries) {
          expect(
            recovery.input.match(/process was lost when the Gateway restarted/gi),
          ).toHaveLength(1);
        }
        const recoveryCount = recoveries.length;
        expect(recoveryCount).toBe(mode === "SIGKILL" ? 2 : 1);
        await restart("managed");
        await waitForIdleFinal(SESSION_KEY, RECOVERY_FINAL);
        expect(provider.calls.filter((call) => call.kind === "recovery")).toHaveLength(
          recoveryCount,
        );
        await waitForIdleFinal(CANCEL_KEY, CANCEL_FINAL);
        await waitForIdleFinal(REVOKED_KEY, REVOKED_FINAL);
        expect(provider.calls.filter((call) => call.kind === "revocation-recovery")).toHaveLength(
          2,
        );
        expect(await readFile(path.join(instance.state.workspaceDir, "exec-count"), "utf8")).toBe(
          "started\n",
        );
        expect(await readFile(path.join(instance.state.workspaceDir, "cancel-count"), "utf8")).toBe(
          "started\n",
        );
        expect(
          await readFile(path.join(instance.state.workspaceDir, "revoked-count"), "utf8"),
        ).toBe("started\n");
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);
