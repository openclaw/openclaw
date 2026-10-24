// Separate Gateway processes prove automatic owner-authorized recovery and terminal cancellation.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
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

const writeTool = (response: ServerResponse, name: string, args: object, ordinal: number) =>
  writeRestartToolCall(response, "resume", name, args, ordinal);

async function startProvider(signal: AbortSignal, holdFirstResume: boolean) {
  const suspended = new Map(CASES.map((name) => [name, createDeferred()]));
  const resumed = createDeferred();
  const releaseResume = createDeferred();
  const revocationReady = createDeferred();
  const releaseRevoked = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const delegated = new Set<ResumeCase>();
  const checkpointed = new Set<ResumeCase>();
  const adopted = new Set<ResumeCase>();
  const resumeInputs: Array<{ name: ResumeCase; input: string }> = [];
  const revokeAttempted = new Set<ResumeCase>();
  let operatorEffectIssued = false;
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
    resumeInputs,
    release: () => releaseResume.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseResume.resolve();
          releaseRevoked.resolve();
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

async function createFixture(signal: AbortSignal, holdFirstResume: boolean) {
  const provider = await startProvider(signal, holdFirstResume);
  const instance = await createInstance(provider, signal);
  let client: GatewayClient;
  const race = <T>(promise: Promise<T>) =>
    withinTest(Promise.race([promise, provider.failed]), signal);
  const request = <T = Record<string, unknown>>(...args: Parameters<GatewayClient["request"]>) =>
    client.request<T>(...args);
  const rows = async () =>
    (await request<SessionsListResult>("sessions.list", { agentId: "main" })).sessions;
  const row = async (key: string) => (await rows()).find((entry) => entry.key === key);
  const start = async () => {
    await instance.startGateway();
    client = await connectRestartClient(
      instance,
      { mode: holdFirstResume ? "test" : "backend" },
      signal,
    );
  };
  return {
    provider,
    instance,
    race,
    request,
    rows,
    row,
    start,
    wait: (assertion: () => Promise<void>) => race(vi.waitFor(assertion, { timeout: 30_000 })),
    read: (name: string) => readFile(path.join(instance.state.workspaceDir, name), "utf8"),
    create: (key: string) =>
      request("sessions.create", { key, agentId: "main", permissionMode: "full" }),
    send: (sessionKey: string, message: string, idempotencyKey: string) =>
      request<{ runId: string }>(
        "chat.send",
        { sessionKey, message, idempotencyKey },
        { expectFinal: false },
      ),
    readOnly: (key: string) => applyReadOnly(client, instance, key),
    close: () => client?.stopAndWait(),
    restart: async (kind: RestartMode) => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
      await client.stopAndWait();
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
      await race(closed);
      await start();
      expect(instance.child?.pid).not.toBe(child.pid);
    },
  };
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

it.skipIf(process.platform === "win32").for(["managed", "SIGTERM", "SIGKILL"] as const)(
  "automatically continues delegated owner work in place after %s",
  { timeout: 180_000 },
  async (mode, { signal }) => {
    const fixture = await createFixture(signal, mode === "SIGKILL");
    await runQaGatewayFixture(
      async () => {
        await fixture.start();
        const { provider, race, rows, request, wait, create, send, read, readOnly, restart } =
          fixture;
        const row = (name: ResumeCase) => fixture.row(targetKey(name));
        const waitFinal = (name: ResumeCase) =>
          wait(async () => {
            expect(
              JSON.stringify(await request("chat.history", { sessionKey: targetKey(name) })),
            ).toContain(final(name));
            expect(await row(name)).toMatchObject({ status: "done", hasActiveRun: false });
          });
        const identities = new Map<ResumeCase, string>();
        for (const name of CASES) {
          await create(targetKey(name));
          await create(sourceKey(name));
          const accepted = await send(sourceKey(name), sourceRequest(name), `delegate-${name}`);
          await race(provider.suspended(name));
          expect(
            await request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok" });
          const current = await row(name);
          expect(current).toMatchObject({ hasActiveRun: true, sessionId: expect.any(String) });
          identities.set(name, current!.sessionId!);
          expect(await read(`effect-${name}`)).toBe("completed\n");
        }
        const cancelled = await request<{ aborted: boolean; warning?: string }>("chat.abort", {
          sessionKey: targetKey("cancel"),
        });
        expect(cancelled.aborted).toBe(true);
        expect(cancelled.warning).toBeUndefined();
        // The live projection clears before the cancellation write has settled.
        await wait(async () => {
          expect(await row("cancel")).toMatchObject({ status: "killed", hasActiveRun: false });
        });
        // Change the retained task before recovery prepares its next tool surface.
        await readOnly(targetKey("restricted"));
        for (const name of ["revoked", "restricted", "continue"] as const) {
          provider.adopted(name);
        }
        await restart(mode);
        expect(await row("cancel")).toMatchObject({ status: "killed", hasActiveRun: false });
        expect((await row("cancel"))?.restartRecoveryStatus).toBeUndefined();
        await expect(
          request("sessions.recover", {
            key: targetKey("cancel"),
            mode: "in-place",
            sessionId: identities.get("cancel"),
            recoveryCycleId: "cancelled-has-no-recovery-cycle",
          }),
        ).rejects.toThrow(/restart-tombstoned|not recoverable|changed/);
        // Revoke after the recovered model request starts, before its tool can act.
        await race(provider.revocationReady);
        await readOnly(targetKey("revoked"));
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
          expect(await read(`effect-${name}`)).toBe("completed\n");
          expect((await row(name))?.sessionId).toBe(identities.get(name));
          expect((await row(name))?.restartRecoveryStatus).toBeUndefined();
        }
        for (const name of ["revoked", "restricted"]) {
          await expect(read(`${name}-effect`)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await read("operator-effect")).toBe("resumed\n");
        expect(
          (await rows()).filter((entry) => entry.key.startsWith("agent:main:operator-resume-")),
        ).toHaveLength(8);
      },
      fixture.close,
      () => fixture.instance.cleanup(),
      fixture.provider.close,
    );
  },
);
