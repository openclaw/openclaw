// Separate Gateway processes prove that an operator can adopt a tombstoned task.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { SessionsRecoverResult } from "../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
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

function writeTool(response: ServerResponse, name: string, args: object, ordinal: number) {
  const item = {
    type: "function_call",
    id: `fc_resume_${ordinal}`,
    call_id: `call_resume_${ordinal}`,
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
        id: `resp_resume_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startProvider(signal: AbortSignal, holdFirstResume: boolean) {
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
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          expect(request.url).toBe("/v1/responses");
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          const input = JSON.stringify(body.input);
          const callOrdinal = ++ordinal;
          const text = (value: string) => {
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: `resp_resume_${callOrdinal}`,
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: `msg_resume_${callOrdinal}`,
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
              text(`DELEGATED_${source}`);
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
          if (!adopted.has(name)) {
            suspended.get(name)!.resolve();
            // Keep the real model request open until the process is stopped or cancelled.
            return;
          }
          expect(name).not.toBe("cancel");
          expect(input).toContain("unknown outcome");
          expect(input).toContain("Verify what happened before repeating an action");
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
                      : expect.stringContaining("exec denied"),
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
  const instance = await createOpenClawTestInstance({
    name: "gateway-session-resume-restart",
    signal,
    startTimeoutMs: 120_000,
    stopTimeoutMs: 10_000,
    gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
    env: {
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_API_BASE: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_NO_RESPAWN: "1",
    },
  });
  await instance.state.writeConfig({
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
        workspace: instance.state.workspaceDir,
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
) {
  return acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      clientName: "gateway-client",
      mode: "backend",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: instance.state.path("device", "client", "credentials.sqlite"),
      }),
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: "resume client did not connect",
      closeMessage: "resume client closed",
      signal,
    },
  );
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
  "resumes a tombstoned delegated task in place after %s with fresh operator authority",
  { timeout: 180_000 },
  async (mode, { signal }) => {
    const provider = await startProvider(signal, mode === "SIGKILL");
    const instance = await createInstance(provider, signal);
    let client: GatewayClient | undefined;
    const connect = () => connectInstance(instance, signal);
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
            expect(await row(name)).toMatchObject({ hasActiveRun: false });
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
        await restart(mode);
        await race(
          vi.waitFor(
            async () => {
              for (const name of ["continue", "revoked", "restricted"] as const) {
                expect(await row(name)).toMatchObject({
                  sessionId: identities.get(name),
                  restartRecoveryStatus: "tombstoned",
                  hasActiveRun: false,
                });
                expect(
                  JSON.stringify(
                    await client!.request("chat.history", { sessionKey: targetKey(name) }),
                  ),
                ).toContain("delegated recovery sender authority is unavailable");
              }
            },
            { timeout: 30_000 },
          ),
        );
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
        const resumeRequests = new Map<
          ResumeCase,
          {
            key: string;
            mode: "in-place";
            sessionId: string;
            recoveryCycleId: string;
          }
        >();
        await client!.request("sessions.patch", {
          key: targetKey("restricted"),
          permissionMode: "read-only",
        });
        for (const name of ["revoked", "restricted", "continue"] as const) {
          const current = await row(name);
          expect(current?.restartRecoveryCycleId).toEqual(expect.any(String));
          const request = {
            key: targetKey(name),
            mode: "in-place" as const,
            sessionId: identities.get(name)!,
            recoveryCycleId: current!.restartRecoveryCycleId!,
          };
          resumeRequests.set(name, request);
          provider.adopted(name);
          const resumed = await client!.request<SessionsRecoverResult>("sessions.recover", request);
          expect(resumed).toMatchObject({
            key: targetKey(name),
            sessionId: identities.get(name),
            continuation: { status: "started" },
          });
          if (name === "revoked") {
            await race(provider.revocationReady);
            await applyReadOnly(client!, instance, targetKey("revoked"));
            expect(await row("revoked")).toMatchObject({ permissionMode: "read-only" });
            provider.releaseRevoked();
            await waitFinal(name);
          }
          if (name === "restricted") {
            await waitFinal(name);
          }
        }
        await race(provider.resumed);
        if (mode === "SIGKILL") {
          await expect(
            client!.request("sessions.recover", resumeRequests.get("continue")!),
          ).rejects.toThrow(/restart-tombstoned|changed/);
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
