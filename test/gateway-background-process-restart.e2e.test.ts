// Real process replacement covers the idle-session handoff that owner tests cannot prove.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { killProcessTree } from "../src/process/kill-tree.js";
import { getFileLockProcessStartTime } from "../src/shared/pid-alive.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  restartEnv,
  connectRestartClient,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  restartModelConfig,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
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
      restartProviderServer(
        failed,
        async (request, response, body) => {
          expect(request.url).toBe("/v1/responses");
          const tools = restartToolNames(body);
          const input = JSON.stringify(body.input);
          ordinal += 1;
          const text = (value: string) => {
            if (body.stream === false) {
              writeRestartJsonText(response, value, String(ordinal));
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
            writeRestartToolCall(
              response,
              "exec",
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
        },
        { ignoreAborted: true },
      ),
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
        ...restartModelConfig(model, undefined),
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
        ...restartEnv,
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
    const calls = (kind: (typeof provider.calls)[number]["kind"]) =>
      provider.calls.filter((call) => call.kind === kind);
    const readEffect = (file: string) =>
      readFile(path.join(instance.state.workspaceDir, file), "utf8");
    const connect = () => connectRestartClient(instance, { mode: "backend" }, signal);
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
          const accepted = await client.request<{ runId: string }>(
            "chat.send",
            { sessionKey, message, idempotencyKey: sessionKey },
            { expectFinal: false },
          );
          await waitForIdleFinal(sessionKey, final);
          // Idle presentation can precede cleanup of the run's permission owner.
          expect(
            await client.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok" });
        }
        await client.request("sessions.patch", { key: REVOKED_KEY, permissionMode: "read-only" });
        expect(await readEffect("exec-count")).toBe("started\n");
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
        expect(calls("revocation-recovery")).toHaveLength(2);
        await expect(
          readFile(path.join(instance.state.workspaceDir, "revoked-effect")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        // Display history hides exec inputs; count notices at the model boundary.
        const recoveries = calls("recovery");
        for (const recovery of recoveries) {
          expect(
            recovery.input.match(/process was lost when the Gateway restarted/gi),
          ).toHaveLength(1);
        }
        const recoveryCount = recoveries.length;
        expect(recoveryCount).toBe(mode === "SIGKILL" ? 2 : 1);
        await restart("managed");
        await waitForIdleFinal(SESSION_KEY, RECOVERY_FINAL);
        expect(calls("recovery")).toHaveLength(recoveryCount);
        await waitForIdleFinal(CANCEL_KEY, CANCEL_FINAL);
        await waitForIdleFinal(REVOKED_KEY, REVOKED_FINAL);
        expect(calls("revocation-recovery")).toHaveLength(2);
        expect(
          await Promise.all(["exec-count", "cancel-count", "revoked-count"].map(readEffect)),
        ).toEqual(["started\n", "started\n", "started\n"]);
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);
