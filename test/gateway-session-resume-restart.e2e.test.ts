// Separate Gateway processes prove automatic owner-authorized recovery and terminal cancellation.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readPendingInputSource } from "../src/config/sessions/session-pending-input-source.js";
import { parseSessionPendingInputMessage } from "../src/config/sessions/session-pending-input-value.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { readSessionSendDelivery } from "../src/gateway/session-send-delivery.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
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

const CASES = ["continue", "cancel", "revoked", "restricted"] as const;
type ResumeCase = (typeof CASES)[number];
type RestartMode = "managed" | "SIGTERM" | "SIGKILL";
const targetKey = (name: ResumeCase) => `agent:main:operator-resume-${name}`;
const sourceKey = (name: ResumeCase) => `agent:main:operator-resume-source-${name}`;
const sourceRequest = (name: ResumeCase) => `DELEGATE_RESTART_${name.toUpperCase()}`;
const task = (name: ResumeCase) =>
  `RETAINED_TASK_${name.toUpperCase()}: finish after the checkpoint.`;
const final = (name: ResumeCase) => `RETAINED_TASK_${name.toUpperCase()}_FINISHED`;
const ORDINARY_KEY = "agent:main:ordinary-permission-control";
const ORDINARY_REQUEST = "ORDINARY_PERMISSION_CONTROL: wait for the operator.";
const ORDINARY_FINAL = "ORDINARY_PERMISSION_CHANGE_FINISHED";

const writeTool = (response: ServerResponse, name: string, args: object, ordinal: number) =>
  writeRestartToolCall(response, "resume", name, args, ordinal);

async function startProvider(
  signal: AbortSignal,
  holdFirstResume: boolean,
  automaticReply = false,
) {
  const suspended = new Map(CASES.map((name) => [name, createDeferred()]));
  const resumed = createDeferred();
  const releaseResume = createDeferred();
  const revocationReady = createDeferred();
  const releaseRevoked = createDeferred();
  const ordinaryReady = createDeferred();
  const releaseOrdinary = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const delegated = new Set<ResumeCase>();
  const checkpointed = new Set<ResumeCase>();
  const adopted = new Set<ResumeCase>();
  const resumeInputs: Array<{ name: ResumeCase; input: string }> = [];
  const revokeAttempted = new Set<ResumeCase>();
  let operatorEffectIssued = false;
  let ordinaryEffectIssued = false;
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
          const callOrdinal = ++ordinal;
          const text = (value: string) => {
            if (body.stream === false) {
              writeRestartJsonText(response, value, `resume_${callOrdinal}`);
            } else {
              writeOpenAiResponsesText(response, {
                text: value,
                messageId: `msg_resume_${callOrdinal}`,
                responseId: `resp_resume_${callOrdinal}`,
              });
            }
          };
          const tool = (name: string, args: object) => {
            const wireName = tools.includes(name) ? name : "dispatch_action";
            expect(tools).toContain(wireName);
            writeTool(
              response,
              wireName,
              wireName === name ? args : { id: name, args },
              callOrdinal,
            );
          };
          if (tools.length === 0) {
            text("Synthetic session resume");
            return;
          }
          if (input.includes(ORDINARY_REQUEST)) {
            if (!ordinaryEffectIssued) {
              ordinaryReady.resolve();
              await withinTest(releaseOrdinary.promise, signal);
              if (response.destroyed) {
                return;
              }
              ordinaryEffectIssued = true;
              tool("exec", { command: "printf 'forbidden\\n' > ordinary-effect" });
            } else {
              const results = Array.isArray(body.input)
                ? body.input.filter(
                    (item) => isRecord(item) && item.type === "function_call_output",
                  )
                : [];
              expect(results.at(-1)).toMatchObject({ output: "Permission change" });
              text(ORDINARY_FINAL);
            }
            return;
          }
          const source = CASES.find((name) => input.includes(sourceRequest(name)));
          if (source) {
            if (delegated.has(source)) {
              expect(input).toContain("accepted");
              if (automaticReply && !adopted.has(source)) {
                suspended.get(source)!.resolve();
                return;
              }
              text(
                automaticReply && input.includes(final(source))
                  ? "AUTOMATIC_REPLY_CONSUMED"
                  : `DELEGATED_${source}`,
              );
            } else {
              delegated.add(source);
              tool("sessions_send", {
                sessionKey: targetKey(source),
                message: task(source),
                timeoutSeconds: 0,
              });
            }
            return;
          }
          const name = CASES.find((candidate) => input.includes(task(candidate)));
          expect(name, input).toBeDefined();
          if (!name) {
            throw new Error("Provider received an unrelated task");
          }
          if (!checkpointed.has(name)) {
            checkpointed.add(name);
            tool("exec", {
              command: `printf 'completed\\n' >> effect-${name}; printf 'CHECKPOINT_${name}\\n'`,
            });
            return;
          }
          expect(input).toContain(`CHECKPOINT_${name}`);
          if (automaticReply) {
            text(final(name));
            return;
          }
          if (!adopted.has(name)) {
            suspended.get(name)!.resolve();
            // Keep the real model request open until the process is stopped or cancelled.
            return;
          }
          expect(name).not.toBe("cancel");
          expect(input).toContain("interrupted by a gateway restart");
          resumeInputs.push({ name, input });
          if (name === "revoked" || name === "restricted") {
            if (!revokeAttempted.has(name)) {
              if (name === "revoked") {
                revocationReady.resolve();
                await withinTest(releaseRevoked.promise, signal);
                if (response.destroyed) {
                  return;
                }
              }
              revokeAttempted.add(name);
              const args = { command: `printf 'forbidden\\n' > ${name}-effect` };
              if (
                name === "restricted" &&
                !tools.includes("exec") &&
                !tools.includes("dispatch_action")
              ) {
                // A provider can still issue a stale call after recovery removes the tool.
                writeTool(response, "exec", args, callOrdinal);
              } else {
                tool("exec", args);
              }
            } else {
              const results = Array.isArray(body.input)
                ? body.input.filter(
                    (item) => isRecord(item) && item.type === "function_call_output",
                  )
                : [];
              expect(results.at(-1)).toMatchObject({
                output:
                  name === "revoked"
                    ? "Permission change"
                    : !tools.includes("exec") && !tools.includes("dispatch_action")
                      ? "Tool exec not found"
                      : // The session tool pin keeps exec offered and refuses it at call time.
                        expect.stringMatching(/exec denied|exec is not available in this turn/),
              });
              text(final(name));
            }
            return;
          }
          resumed.resolve();
          if (
            holdFirstResume &&
            resumeInputs.filter((call) => call.name === "continue").length === 1
          ) {
            await withinTest(releaseResume.promise, signal);
            if (response.destroyed) {
              return;
            }
          }
          if (!operatorEffectIssued) {
            operatorEffectIssued = true;
            tool("exec", {
              command:
                "printf 'resumed\\n' >> operator-effect; printf 'OPERATOR_EFFECT_CONFIRMED\\n'",
            });
            return;
          }
          expect(input).toContain("OPERATOR_EFFECT_CONFIRMED");
          text(final(name));
        },
        { ignoreAborted: true },
      ),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    failed: failed.promise,
    suspended: (name: ResumeCase) => suspended.get(name)!.promise,
    adopted: (name: ResumeCase) => adopted.add(name),
    resumed: resumed.promise,
    revocationReady: revocationReady.promise,
    releaseRevoked: () => releaseRevoked.resolve(),
    ordinaryReady: ordinaryReady.promise,
    releaseOrdinary: () => releaseOrdinary.resolve(),
    resumeInputs,
    release: () => releaseResume.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseResume.resolve();
          releaseRevoked.resolve();
          releaseOrdinary.resolve();
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

async function createInstance(
  provider: Awaited<ReturnType<typeof startProvider>>,
  signal: AbortSignal,
) {
  const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",");
  const instance = await createOpenClawTestInstance({
    name: "gateway-session-resume-restart",
    signal,
    startTimeoutMs: 120_000,
    stopTimeoutMs: 10_000,
    gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
    env: {
      // Keep only the owned loopback fixtures direct; preserve external proxy routing.
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...restartEnv,
      OPENCLAW_NO_RESPAWN: "1",
    },
  });
  await instance.state.writeConfig({
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    plugins: { enabled: false },
    ...restartModelConfig(
      model,
      instance.state.workspaceDir,
      {},
      { catalogRefresh: { enabled: false } },
    ),
    tools: {
      allow: ["exec", "sessions_send"],
      codeMode: { enabled: false },
      sessions: { visibility: "all" },
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
  return instance;
}

function connectInstance(
  instance: Awaited<ReturnType<typeof createInstance>>,
  signal: AbortSignal,
  profiled = false,
) {
  return connectRestartClient(instance, { mode: profiled ? "test" : "backend" }, signal);
}

async function applyReadOnly(
  client: GatewayClient,
  instance: Awaited<ReturnType<typeof createInstance>>,
  key: string,
) {
  try {
    await client.request("sessions.patch", { key, permissionMode: "read-only" });
  } catch (error) {
    const diagnostics = instance
      .logs()
      .split("\n")
      .filter((line) => line.includes("Permission change failed:"));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}`, { cause: error });
  }
}

it.skipIf(process.platform === "win32")(
  "applies an ordinary operator permission change while inference is pending",
  { timeout: 120_000 },
  async ({ signal }) => {
    const provider = await startProvider(signal, false);
    const instance = await createInstance(provider, signal);
    let client: GatewayClient | undefined;
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectInstance(instance, signal);
        await client.request("sessions.create", {
          key: ORDINARY_KEY,
          agentId: "main",
          permissionMode: "full",
        });
        await client.request(
          "chat.send",
          {
            sessionKey: ORDINARY_KEY,
            message: ORDINARY_REQUEST,
            idempotencyKey: "ordinary-control",
          },
          { expectFinal: false },
        );
        await race(provider.ordinaryReady);
        await applyReadOnly(client, instance, ORDINARY_KEY);
        provider.releaseOrdinary();
        await race(
          vi.waitFor(
            async () => {
              const history = await client!.request("chat.history", { sessionKey: ORDINARY_KEY });
              expect(JSON.stringify(history)).toContain(ORDINARY_FINAL);
              const sessions = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(sessions.sessions.find((row) => row.key === ORDINARY_KEY)).toMatchObject({
                hasActiveRun: false,
                permissionMode: "read-only",
              });
            },
            { timeout: 30_000 },
          ),
        );
        await expect(
          readFile(path.join(instance.state.workspaceDir, "ordinary-effect")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);

it.skipIf(process.platform === "win32").for(["managed", "SIGTERM", "SIGKILL"] as const)(
  "automatically continues delegated owner work in place after %s",
  { timeout: 180_000 },
  async (mode, { signal }) => {
    const provider = await startProvider(signal, mode === "SIGKILL");
    const instance = await createInstance(provider, signal);
    let client: GatewayClient | undefined;
    const connect = () => connectInstance(instance, signal, mode === "SIGKILL");
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    const rows = async () =>
      (await client!.request<SessionsListResult>("sessions.list", { agentId: "main" })).sessions;
    const row = async (name: ResumeCase) =>
      (await rows()).find((entry) => entry.key === targetKey(name));
    const waitFinal = (name: ResumeCase) =>
      race(
        vi.waitFor(
          async () => {
            expect(
              JSON.stringify(
                await client!.request("chat.history", { sessionKey: targetKey(name) }),
              ),
            ).toContain(final(name));
            expect(await row(name)).toMatchObject({ status: "done", hasActiveRun: false });
          },
          { timeout: 30_000 },
        ),
      );
    const restart = async (kind: RestartMode) => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
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
    };
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connect();
        const identities = new Map<ResumeCase, string>();
        for (const name of CASES) {
          await client.request("sessions.create", {
            key: targetKey(name),
            agentId: "main",
            permissionMode: "full",
          });
          await client.request("sessions.create", {
            key: sourceKey(name),
            agentId: "main",
            permissionMode: "full",
          });
          const accepted = await client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: sourceKey(name),
              message: sourceRequest(name),
              idempotencyKey: `delegate-${name}`,
            },
            { expectFinal: false },
          );
          await race(provider.suspended(name));
          expect(
            await client.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok" });
          const current = await row(name);
          expect(current).toMatchObject({ hasActiveRun: true, sessionId: expect.any(String) });
          identities.set(name, current!.sessionId!);
          expect(
            await readFile(path.join(instance.state.workspaceDir, `effect-${name}`), "utf8"),
          ).toBe("completed\n");
        }
        const cancelled = await client.request<{ aborted: boolean; warning?: string }>(
          "chat.abort",
          { sessionKey: targetKey("cancel") },
        );
        expect(cancelled.aborted).toBe(true);
        expect(cancelled.warning).toBeUndefined();
        await race(
          vi.waitFor(
            // The live projection clears before the cancellation write has settled.
            async () =>
              expect(await row("cancel")).toMatchObject({
                status: "killed",
                hasActiveRun: false,
              }),
            { timeout: 30_000 },
          ),
        );
        // Change the retained task before recovery prepares its next tool surface.
        await applyReadOnly(client!, instance, targetKey("restricted"));
        for (const name of ["revoked", "restricted", "continue"] as const) {
          provider.adopted(name);
        }
        await restart(mode);
        expect(await row("cancel")).toMatchObject({ status: "killed", hasActiveRun: false });
        expect((await row("cancel"))?.restartRecoveryStatus).toBeUndefined();
        await expect(
          client!.request("sessions.recover", {
            key: targetKey("cancel"),
            mode: "in-place",
            sessionId: identities.get("cancel"),
            recoveryCycleId: "cancelled-has-no-recovery-cycle",
          }),
        ).rejects.toThrow(/restart-tombstoned|not recoverable|changed/);
        // Revoke after the recovered model request starts, before its tool can act.
        await race(provider.revocationReady);
        await applyReadOnly(client!, instance, targetKey("revoked"));
        expect(await row("revoked")).toMatchObject({ permissionMode: "read-only" });
        provider.releaseRevoked();
        await Promise.all([waitFinal("revoked"), waitFinal("restricted")]);
        await race(provider.resumed);
        if (mode === "SIGKILL") {
          await restart("SIGKILL");
          provider.release();
        }
        await waitFinal("continue");
        expect(provider.resumeInputs.filter((call) => call.name === "continue")).toHaveLength(
          mode === "SIGKILL" ? 3 : 2,
        );
        for (const name of CASES) {
          expect(
            await readFile(path.join(instance.state.workspaceDir, `effect-${name}`), "utf8"),
          ).toBe("completed\n");
          expect((await row(name))?.sessionId).toBe(identities.get(name));
          expect((await row(name))?.restartRecoveryStatus).toBeUndefined();
        }
        for (const name of ["revoked", "restricted"]) {
          await expect(
            readFile(path.join(instance.state.workspaceDir, `${name}-effect`)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(
          await readFile(path.join(instance.state.workspaceDir, "operator-effect"), "utf8"),
        ).toBe("resumed\n");
        expect(
          (await rows()).filter((entry) => entry.key.startsWith("agent:main:operator-resume-")),
        ).toHaveLength(8);
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);

it.skipIf(process.platform === "win32").for(["restart", "stop"] as const)(
  "preserves automatic peer result custody across %s and process death",
  { timeout: 180_000 },
  async (mode, context) => {
    const { signal } = context;
    const provider = await startProvider(signal, false, true);
    const instance = await createInstance(provider, signal);
    let client: GatewayClient | undefined;
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    let lastHistory: unknown;
    const history = async () => {
      const result = await client!.request<{
        messages: unknown[];
        pendingInputs?: {
          items: Array<{ id: string; runId: string; state: string; message: unknown }>;
        };
      }>("chat.history", { sessionKey: sourceKey("continue"), limit: 100 });
      lastHistory = result;
      return result;
    };
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectInstance(instance, signal, true);
        for (const key of [sourceKey("continue"), targetKey("continue")]) {
          await client.request("sessions.create", { key, agentId: "main", permissionMode: "full" });
        }
        // The original request is allowed, but neither endpoint permits a new
        // reverse-direction send. Its requested result must still be admitted.
        await client.request("sessions.patch", {
          key: sourceKey("continue"),
          communication: { receive: "never" },
        });
        await client.request("sessions.patch", {
          key: targetKey("continue"),
          communication: { send: "never" },
        });
        await client.request(
          "chat.send",
          {
            sessionKey: sourceKey("continue"),
            message: sourceRequest("continue"),
            idempotencyKey: "automatic-return-source",
          },
          { expectFinal: false },
        );
        await race(provider.suspended("continue"));
        let pendingId: string | undefined;
        let pendingRunId: string | undefined;
        await race(
          vi.waitFor(
            async () => {
              const input = (await history()).pendingInputs?.items.find((item) =>
                JSON.stringify(item.message).includes(final("continue")),
              );
              expect(input).toMatchObject({ state: "queued" });
              pendingId = input!.id;
              pendingRunId = input!.runId;
            },
            { timeout: 30_000 },
          ),
        );
        const rowsBefore = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        const sourceSessionId = rowsBefore.sessions.find(
          (row) => row.key === sourceKey("continue"),
        )!.sessionId;
        if (!sourceSessionId) {
          throw new Error("Expected the source session before reading retained input");
        }
        const pendingScope = {
          agentId: "main",
          sessionKey: sourceKey("continue"),
          sessionId: sourceSessionId,
          env: instance.env,
        };
        const savedInput = await readPendingInputSource(
          pendingScope,
          `${pendingRunId}:user`,
          false,
        );
        expect(savedInput?.snapshot.pending).toBeDefined();
        const savedMessage = parseSessionPendingInputMessage(
          savedInput!.snapshot.pending!.message_json,
        );
        expect(readSessionSendDelivery(savedMessage)?.returnedResult).toEqual({
          extraSystemPrompt: expect.any(String),
        });
        context.onTestFailed(() => {
          console.error(
            "[automatic-peer-result:" +
              mode +
              "]\n" +
              instance.logs().replaceAll(instance.gatewayToken, "[fixture token]"),
          );
          console.error(JSON.stringify(lastHistory));
        });
        provider.adopted("continue");
        if (mode === "stop") {
          expect(
            await client.request("chat.abort", { sessionKey: sourceKey("continue") }),
          ).toMatchObject({ aborted: true });
          await race(
            vi.waitFor(
              async () => {
                const rows = await client!.request<SessionsListResult>("sessions.list", {
                  agentId: "main",
                });
                expect(
                  rows.sessions.find((row) => row.key === sourceKey("continue")),
                ).toMatchObject({ status: "killed", hasActiveRun: false });
              },
              { timeout: 30_000 },
            ),
          );
        }
        await client.stopAndWait();
        client = undefined;
        const child = instance.child!;
        const closed = once(child, "close");
        expect(child.kill("SIGKILL")).toBe(true);
        await race(closed);
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(child.pid);
        client = await connectInstance(instance, signal, true);
        if (mode === "stop") {
          const current = await history();
          const saved = await readPendingInputSource(pendingScope, `${pendingRunId}:user`, false);
          // Terminal cancellation retires the queued row through its completion receipt.
          expect(saved?.snapshot).toMatchObject({ current: true });
          expect(saved?.snapshot.pending).toBeUndefined();
          expect(saved?.snapshot.committed).toBeUndefined();
          expect(
            current.pendingInputs?.items.find((item) => item.id === pendingId),
          ).toBeUndefined();
          expect(JSON.stringify(current.messages)).not.toContain("AUTOMATIC_REPLY_CONSUMED");
          const rows = await client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
          });
          expect(rows.sessions.find((row) => row.key === sourceKey("continue"))).toMatchObject({
            status: "killed",
            hasActiveRun: false,
          });
          return;
        }
        await race(
          vi.waitFor(
            async () => {
              const current = await history();
              expect(JSON.stringify(current.messages)).toContain("AUTOMATIC_REPLY_CONSUMED");
              expect(
                current.pendingInputs?.items.find((item) => item.id === pendingId),
              ).toBeUndefined();
              const returned = current.messages.filter((message) => {
                const record = asRecord(message);
                return (
                  asRecord(record.provenance).sourceSessionKey === targetKey("continue") &&
                  JSON.stringify(record.content).includes(final("continue"))
                );
              });
              expect(returned).toHaveLength(1);
              const rows = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(rows.sessions.find((row) => row.key === sourceKey("continue"))).toMatchObject({
                status: "done",
                hasActiveRun: false,
              });
            },
            { timeout: 30_000 },
          ),
        );
        expect(
          await readFile(path.join(instance.state.workspaceDir, "effect-continue"), "utf8"),
        ).toBe("completed\n");
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);
