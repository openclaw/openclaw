import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { restartResumeConfig } from "./gateway-restart-resume.test-support.js";
import {
  connectRestartClient,
  readRestartSession,
  restartEnv,
  restartProviderServer,
  restartToolNames,
  writeRestartPlugin,
  writeRestartJsonText,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const RESUME =
  "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue.";
const CASES = ["stream", "tool", "parent", "background", "idle", "compact"] as const;
type Case = (typeof CASES)[number];
const agent = (name: Case) => (name === "stream" || name === "tool" ? "other" : "main");
const key = (cycle: number, name: Case) =>
  `agent:${agent(name)}:main:thread:restart-resume-${cycle}-${name}`;
const marker = (cycle: number, name: Case) => `RESTART_CASE_${cycle}_${name}`;
const childMarker = (cycle: number) => `RESTART_CHILD_${cycle}`;
const queued = (cycle: number, ordinal: number) => `QUEUED_BEFORE_RESTART_${cycle}_${ordinal}`;
const LITERAL_QUEUED_COMMAND = "/stop";
const fresh = (cycle: number) => `FRESH_AFTER_RESTART_${cycle}`;
const CRASH_QUEUED = "QUEUED_BEFORE_SIGKILL_MUST_REMAIN_INERT";
const AFTER_CRASH = "FRESH_AFTER_CRASH_WORKS";
const WARMUP = "COMPACTION_HISTORY_TO_SUMMARIZE";

function expectCleanHistory(messages: unknown[]) {
  expect(
    messages
      .filter(isRecord)
      .some((message) => message.stopReason === "error" || message.openclawRunError !== undefined),
  ).toBe(false);
  expect(JSON.stringify(messages)).not.toMatch(
    /interrupted before the agent started|subagent failed|restart recovery blocked|use \/new or \/reset/i,
  );
}

function currentInput(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return JSON.stringify(
    input.slice(input.findLastIndex((item) => isRecord(item) && item.role === "assistant") + 1),
  );
}

function hasNewResumeInput(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? body.input : [];
  const lastResponse = input.findLastIndex(
    (item) =>
      isRecord(item) &&
      (item.role === "assistant" ||
        item.type === "function_call" ||
        item.type === "function_call_output"),
  );
  return input
    .slice(lastResponse + 1)
    .some(
      (item) => isRecord(item) && item.role === "user" && JSON.stringify(item).includes(RESUME),
    );
}

async function providerFixture(signal: AbortSignal) {
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const ready = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const calls: Array<{
    cycle: number;
    name: Case | "child";
    current: string;
    resumeInput: boolean;
    ordinal: number;
  }> = [];
  const summaries: Array<{ cycle: number; ordinal: number }> = [];
  const issued = new Set<string>();
  const heldResumes = new Map<number, { response: ServerResponse; ordinal: number }>();
  let finalizer: ServerResponse | undefined;
  let ordinal = 0;
  let restarting = false;
  let origin = "";
  const gate = (name: string) => {
    let deferred = ready.get(name);
    if (!deferred) {
      deferred = createDeferred();
      ready.set(name, deferred);
    }
    return deferred;
  };
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      restartProviderServer(
        failed,
        async (request, response, body) => {
          if (request.url === "/finalize") {
            finalizer = response;
            gate("finalize").resolve();
            return;
          }
          if (request.url?.startsWith("/tool/") || request.url === "/timer") {
            gate(request.url).resolve();
            response.writeHead(204).end();
            return;
          }
          expect(request.url).toBe("/v1/responses");
          const input = JSON.stringify(body.input);
          const current = currentInput(body);
          const requestOrdinal = ++ordinal;
          const text = (value: string, largeHistory = false) => {
            if (body.stream === false) {
              writeRestartJsonText(response, value, String(requestOrdinal));
            } else {
              writeOpenAiResponsesText(response, {
                text: value,
                messageId: `msg_${requestOrdinal}`,
                responseId: `resp_${requestOrdinal}`,
                ...(largeHistory
                  ? { usage: { input_tokens: 30_000, output_tokens: 10, total_tokens: 30_010 } }
                  : {}),
              });
            }
          };
          const tools = restartToolNames(body);
          if (JSON.stringify(body).includes("You are a context summarization assistant.")) {
            const cycle = Number(/RESTART_CASE_(\d+)_compact/.exec(input)?.[1]);
            expect(Number.isFinite(cycle)).toBe(true);
            summaries.push({ cycle, ordinal: requestOrdinal });
            text(
              `## Goal\nContinue ${marker(cycle, "compact")}.\n## Progress\nThe warmup finished. Check current state and finish the pending work.\n## Next Steps\nRead the current session inventory and finish.`,
            );
            return;
          }
          if (!tools.length) {
            text("Synthetic restart resume session");
            return;
          }
          const child = /RESTART_CHILD_(\d+)/.exec(input);
          const match = /RESTART_CASE_(\d+)_(stream|tool|parent|background|idle|compact)/.exec(
            input,
          );
          const name =
            child && input.includes("You are running as a subagent")
              ? "child"
              : CASES.find((candidate) => candidate === match?.[2]);
          assert(name, `Unexpected synthetic model input: ${current}`);
          const cycle = Number(name === "child" ? child?.[1] : match?.[1]);
          calls.push({
            cycle,
            name,
            current,
            resumeInput: hasNewResumeInput(body),
            ordinal: requestOrdinal,
          });
          if (name === "child") {
            gate(`child:${cycle}`).resolve();
            // The parent resumes; its child settles quietly instead of being adopted.
            return;
          }
          const toolOutput = asRecord(
            Array.isArray(body.input)
              ? body.input.findLast(
                  (item) => isRecord(item) && item.type === "function_call_output",
                )
              : undefined,
          );
          const tool = (id: string, args: object) => {
            const wireName = tools.includes(id) ? id : "dispatch_action";
            expect(tools).toContain(wireName);
            writeRestartToolCall(
              response,
              name,
              wireName,
              wireName === id ? args : { id, args },
              requestOrdinal,
            );
          };
          if (restarting) {
            if (hasNewResumeInput(body)) {
              gate(`resume:${cycle}:${name}`).resolve();
              if (name === "stream") {
                heldResumes.set(cycle, { response, ordinal: requestOrdinal });
                return;
              }
              if (name === "compact" || name === "tool") {
                issued.add(`gateway:${cycle}:${name}`);
                tool("sessions_list", { limit: 20, search: `restart-resume-${cycle}-${name}` });
                return;
              }
              text(`RESUMED_${cycle}_${name}`);
            } else if (issued.delete(`gateway:${cycle}:${name}`)) {
              const result = asRecord(JSON.parse(String(toolOutput.output)));
              expect(result.error).toBeUndefined();
              expect(result.status).not.toBe("error");
              expect(current).toContain(key(cycle, name));
              expect(current).not.toMatch(
                /caller context.*(?:missing|unavailable)|forbidden|not authorized/i,
              );
              text(`RESUMED_${cycle}_${name}`);
            } else {
              text(
                `HANDLED_${current.includes(AFTER_CRASH) ? AFTER_CRASH : current.includes(fresh(cycle)) ? fresh(cycle) : current.includes(LITERAL_QUEUED_COMMAND) ? "LITERAL_STOP" : (/QUEUED_BEFORE_RESTART_\d+_\d+/.exec(current)?.[0] ?? "NEW_INPUT")}`,
              );
            }
            return;
          }
          if (name === "compact" && current.includes(WARMUP)) {
            text(`WARMED_${cycle}_compact`, true);
            return;
          }
          const id = `${cycle}:${name}`;
          if (!issued.has(id) && (name === "tool" || name === "background")) {
            issued.add(id);
            const callback = `${origin}/tool/${cycle}/${name}`;
            const script = `fetch(${JSON.stringify(callback)},{method:'POST',body:'{}'}).then(()=>setInterval(()=>{},1000))`;
            tool("exec", {
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
              ...(name === "background" ? { background: true } : { yieldMs: 120_000 }),
              timeoutSeconds: 600,
            });
            return;
          }
          if (name === "background") {
            const processList = `process-list:${cycle}`;
            if (!issued.has(processList)) {
              issued.add(processList);
              tool("process", { action: "list" });
              return;
            }
            // A launch callback alone does not prove the process still runs at shutdown.
            expect(String(toolOutput.output)).toMatch(/\brunning\s+\S+.* :: /);
          }
          if (name === "parent" && !issued.has(id)) {
            issued.add(id);
            tool("sessions_spawn", {
              taskName: `restart_child_${cycle}`,
              task: childMarker(cycle),
              context: "isolated",
              cleanup: "keep",
              expectsCompletionMessage: true,
            });
            return;
          }
          gate(`ready:${cycle}:${name}`).resolve();
          if (current.includes("GRACEFUL_AFTER_CRASH")) {
            gate("ready:graceful-after-crash").resolve();
          }
          if (name === "stream" || name === "compact") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              `data: ${JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "message",
                  id: `msg_${requestOrdinal}`,
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: `msg_${requestOrdinal}`, output_index: 0, content_index: 0, delta: "Working before restart" })}\n\n`,
            );
            return;
          }
          text(`FINISHED_${cycle}_${name}`);
        },
        { ignoreAborted: true },
      ),
  });
  origin = `http://127.0.0.1:${reservation.claim.port}`;
  return {
    baseUrl: `${origin}/v1`,
    finalizerUrl: `${origin}/finalize`,
    timerUrl: `${origin}/timer`,
    releaseFinalizer: () => {
      finalizer?.writeHead(204).end();
      finalizer = undefined;
    },
    calls,
    summaries,
    failed: failed.promise,
    wait: (name: string) => withinTest(Promise.race([gate(name).promise, failed.promise]), signal),
    restart: () => {
      restarting = true;
    },
    prepare: () => {
      restarting = false;
    },
    release: (cycle: number) => {
      const held = heldResumes.get(cycle);
      assert(held, "The resumed stream was never admitted");
      writeOpenAiResponsesText(held.response, {
        text: `RESUMED_${cycle}_stream`,
        messageId: `msg_${held.ordinal}`,
        responseId: `resp_${held.ordinal}`,
      });
      heldResumes.delete(cycle);
    },
    close: () =>
      runQaGatewayFixture(
        async () => reservation.listener.closeAllConnections(),
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

it.skipIf(process.platform === "win32").for([true, false])(
  "restart markers survive graceful shutdown (suspend/reopen and blocked store: %s)",
  { timeout: 180_000 },
  async (suspended, { signal }) => {
    const provider = await providerFixture(signal);
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
    model.config.models[0].params = { responsesCompactEndpoint: false };
    const instance = await createOpenClawTestInstance({
      name: "gateway-restart-resume",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: 60_000,
      config: restartResumeConfig(model),
      env: {
        ...restartEnv,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_GATEWAY_RESTART_TRACE: "1",
      },
    });
    // Two logical agents share one physical store; resume must retain the session's agent.
    const sharedStore = suspended ? undefined : path.join(instance.stateDir, "shared.sqlite");
    const config = asRecord(JSON.parse(await readFile(instance.configPath, "utf8")));
    const pluginDir = instance.state.path("slow-finalizer");
    await writeRestartPlugin(
      pluginDir,
      {
        id: "slow-finalizer",
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {} },
      },
      `import { channel } from "node:diagnostics_channel";
      export default { id: "slow-finalizer", register(api) {
      channel("openclaw.agent-database.reservation").subscribe((event) => {
        if (event.workerOperations?.includes("session.rowTranscript.backfill"))
          api.logger.info("[close-backfill-proof] " + JSON.stringify(event));
      });
      api.registerService({ id: "shared-state-timer", start(ctx) {
        ctx.scheduler.schedule({ id: "cron-read", delayMs: 0, everyMs: 1000, async run() {
          await ctx.getCron().list();
          await fetch(${JSON.stringify(provider.timerUrl)}, { method: "POST", body: "{}" });
        } });
      }, stop() {} });
      api.on("agent_end", async (event, ctx) => {
        if (!event.success && ctx.sessionKey === ${JSON.stringify(key(0, "stream"))})
          await fetch(${JSON.stringify(provider.finalizerUrl)}, { method: "POST", body: "{}" });
      });
    } };`,
    );
    config.plugins = {
      enabled: !suspended,
      load: { paths: [pluginDir] },
      allow: ["slow-finalizer", "openai"],
      slots: { memory: "none" },
      entries: {
        "slow-finalizer": { enabled: true, hooks: { allowConversationAccess: true } },
      },
    };
    const logPath = instance.state.path("gateway.log");
    config.logging = { level: "info", file: logPath };
    await instance.state.writeConfig({
      ...config,
      ...restartResumeConfig(model, sharedStore),
      plugins: config.plugins,
    });
    let client: GatewayClient | undefined;
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    const runLeases = () => {
      using database = new DatabaseSync(resolveOpenClawStateSqlitePath(instance.env), {
        readOnly: true,
      });
      return database
        .prepare("SELECT owner FROM state_leases WHERE scope LIKE 'worktree-run:%'")
        .all();
    };
    const history = (sessionKey: string) =>
      client!.request<{
        messages: unknown[];
        pendingInputs?: { items: Array<{ state: string; message: unknown }> };
        sessionInfo: { hasActiveRun: boolean };
      }>("chat.history", { sessionKey, limit: 100 });
    const waitHistory = (
      sessionKey: string,
      check: (result: Awaited<ReturnType<typeof history>>) => void,
      timeout = 30_000,
    ) => race(vi.waitFor(async () => check(await history(sessionKey)), { timeout }));
    const waitFinal = (sessionKey: string, text: string) =>
      waitHistory(sessionKey, (result) => {
        expect(JSON.stringify(result.messages), instance.logs()).toContain(text);
        expect(result.sessionInfo.hasActiveRun).toBe(false);
      });
    const waitQueued = (sessionKey: string, messages: string[]) =>
      waitHistory(
        sessionKey,
        (result) => {
          const pending = result.pendingInputs?.items ?? [];
          expect(
            pending.filter(
              (item) =>
                item.state === "queued" &&
                messages.some((text) => JSON.stringify(item.message).includes(text)),
            ),
          ).toHaveLength(messages.length);
        },
        5_000,
      );
    const send = (
      sessionKey: string,
      message: string,
      queueMode?: "followup" | "steer",
      options?: { timeoutMs?: number; suppressCommandInterpretation?: boolean },
    ) =>
      client!.request<{ runId: string }>(
        "chat.send",
        {
          sessionKey,
          message,
          idempotencyKey: randomUUID(),
          suppressCommandInterpretation: options?.suppressCommandInterpretation,
          ...(queueMode ? { queueMode } : {}),
        },
        { expectFinal: false, timeoutMs: options?.timeoutMs },
      );
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        if (!suspended) {
          await provider.wait("/timer");
        }
        client = await connectRestartClient(instance, {}, signal);
        const { profile } = await client.request<{ profile: { id: string } }>("users.self", {});
        for (const [cycle, mode] of (suspended
          ? ["suspend-reopened"]
          : ["SIGTERM", "managed"]
        ).entries()) {
          const cases: readonly Case[] = suspended
            ? ["stream"]
            : CASES.filter((name) => name !== "compact" || cycle === 1);
          provider.prepare();
          await Promise.all(
            cases.map(async (name) => {
              const withWorktree = cycle === 0 && name === "stream" && !suspended;
              const created = await client!.request<{
                entry: { createdActor: { type: string; source: string; id: string } };
              }>("sessions.create", {
                key: key(cycle, name),
                agentId: agent(name),
                permissionMode: "full",
                ...(withWorktree ? { worktree: true, worktreeSource: "empty" } : {}),
              });
              expect(created.entry.createdActor).toMatchObject({
                type: "human",
                source: "profile",
                id: profile.id,
              });
              if (withWorktree) {
                expect(asRecord(created.entry).worktree, instance.logs()).toBeDefined();
              }
              if (name === "compact") {
                await send(
                  key(cycle, name),
                  `${marker(cycle, name)} ${WARMUP}\n${"Retain this completed history detail for the next turn. ".repeat(2_000)}`,
                );
                await waitFinal(key(cycle, name), `WARMED_${cycle}_compact`);
              }
              if (withWorktree) {
                await client!.request(
                  "agent",
                  {
                    sessionKey: key(cycle, name),
                    message: marker(cycle, name),
                    idempotencyKey: randomUUID(),
                  },
                  { expectFinal: false },
                );
              } else {
                await send(key(cycle, name), marker(cycle, name));
              }
            }),
          );
          await race(
            Promise.all(
              cases.map(async (name) => {
                if (name === "tool" || name === "background") {
                  await provider.wait(`/tool/${cycle}/${name}`);
                }
                if (name === "stream" || name === "compact") {
                  await provider.wait(`ready:${cycle}:${name}`);
                } else if (name !== "tool") {
                  if (name === "parent") {
                    await provider.wait(`child:${cycle}`);
                  }
                  await waitFinal(key(cycle, name), `FINISHED_${cycle}_${name}`);
                }
              }),
            ),
          );
          await send(key(cycle, "stream"), LITERAL_QUEUED_COMMAND, "followup", {
            suppressCommandInterpretation: true,
          });
          await send(key(cycle, "stream"), queued(cycle, 2), "followup");
          await waitQueued(key(cycle, "stream"), [LITERAL_QUEUED_COMMAND, queued(cycle, 2)]);
          const child = instance.child;
          assert(child?.pid, "Owned Gateway process unavailable");
          const closed = once(child, "close");
          const shutdownLogStart = (await readFile(logPath, "utf8")).length;
          provider.restart();
          const started = Date.now();
          if (mode === "managed") {
            const target = await client.request<{ pid: number; processInstanceId: string }>(
              "system.info",
              {},
            );
            expect(target.pid).toBe(child.pid);
            const { suspensionId } = await race(
              vi.waitFor(
                async () => {
                  const prepared = await client!.request<{
                    status: string;
                    suspensionId: string;
                  }>("gateway.suspend.prepare", {
                    requestId: "restart-resume-managed",
                    drain: true,
                    terminalPolicy: "terminate",
                  });
                  expect(prepared.status).toBe("ready");
                  return prepared;
                },
                { timeout: 2_000 },
              ),
            );
            expect(
              writeGatewayRestartIntentSync({
                env: instance.env,
                targetPid: child.pid,
                intent: { reason: "gateway.restart", force: true, waitMs: 100 },
              }),
            ).toBe(true);
            expect(
              await client.request("gateway.suspend.handoff", {
                suspensionId,
                target: { pid: target.pid, processInstanceId: target.processInstanceId },
                commit: true,
              }),
            ).toMatchObject({ status: "committed", suspensionId });
          }
          if (mode === "suspend-reopened") {
            const held = await client.request<{ suspensionId: string }>("gateway.suspend.prepare", {
              requestId: "restart-resume-reopened",
              drain: true,
              terminalPolicy: "terminate",
            });
            expect(
              await client.request("gateway.suspend.resume", {
                suspensionId: held.suspensionId,
              }),
            ).toMatchObject({ ok: true, resumed: true });
          }
          await closeOpenClawStateDatabaseAsync();
          if (mode === "SIGTERM") {
            expect(runLeases(), instance.logs()).toHaveLength(1);
          }
          const blockedStore =
            mode === "managed"
              ? undefined
              : new DatabaseSync(
                  mode === "suspend-reopened"
                    ? resolveOpenClawStateSqlitePath(instance.env)
                    : sharedStore!,
                );
          try {
            blockedStore?.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
            expect(child.kill("SIGTERM")).toBe(true);
            if (mode === "SIGTERM") {
              await delay(1_400);
            } else if (blockedStore) {
              await vi.waitFor(
                () =>
                  expect(instance.logs()).toContain("restart signal settlement exceeded 1000ms"),
                { timeout: 2_500 },
              );
            }
          } finally {
            blockedStore?.close();
          }
          if (mode === "SIGTERM") {
            await awaitGateBeforeSettlement(
              provider.wait("finalize"),
              closed,
              "Gateway exited before the finalizer entered",
            ).catch((error: unknown) => {
              throw new Error(`${String(error)}\n${instance.logs()}`, { cause: error });
            });
            await vi.waitFor(
              () =>
                expect(instance.logs()).toContain(
                  "received connection work cleanup exceeded 5000ms",
                ),
              { timeout: 10_000 },
            );
            provider.releaseFinalizer();
          }
          await vi.waitFor(() => expect(child.exitCode, instance.logs()).toBe(0), {
            timeout: 10_000,
          });
          const exit = await race(closed);
          if (mode === "SIGTERM") {
            expect(runLeases()).toEqual([]);
          }
          const shutdownMs = Date.now() - started;
          const shutdownLogs = (await readFile(logPath, "utf8")).slice(shutdownLogStart);
          expect(shutdownLogs).not.toMatch(
            /terminal session persistence failed|input completion persistence failed|failed to settle pending agent input|failed to release worktree run lease/,
          );
          const markerSummary = shutdownLogs.indexOf("shutdown restart resume:");
          const cleanClose = shutdownLogs.indexOf("agent database clean-close receipt:");
          expect(markerSummary, shutdownLogs).toBeGreaterThan(-1);
          expect(cleanClose, shutdownLogs).toBeGreaterThan(markerSummary);
          expect(shutdownLogs.slice(cleanClose).includes("[close-backfill-proof]")).toBe(false);
          const markerAndAbortMs = shutdownLogs.match(
            /restart trace: restart.close.session-abort ([\d.]+)ms/,
          )?.[1];
          process.stdout.write(
            `[restart-resume-proof] ${mode} markerAndAbortMs=${markerAndAbortMs ?? "unavailable"} shutdownMs=${shutdownMs} cleanCloses=${shutdownLogs.match(/^.*agent database clean-close receipt:.*$/gm)?.length ?? 0}\n`,
          );
          expect.soft(exit, instance.logs()).toEqual([0, null]);
          expect
            .soft(shutdownMs, `busy shutdown must finish within ten seconds\n${instance.logs()}`)
            .toBeLessThan(10_000);
          expect(
            readRestartSession(instance.state.agentDir("other"), key(cycle, "stream"), sharedStore)
              ?.resumeAfterRestart,
          ).toBeDefined();
          await client.stopAndWait();
          client = undefined;
          if (suspended) {
            return;
          }
          if (cycle === 1) {
            model.config.models[0].contextWindow = 16_000;
            await instance.state.writeConfig({
              ...config,
              ...restartResumeConfig(model, sharedStore),
            });
          }
          await instance.startGateway();
          client = await connectRestartClient(instance, {}, signal);
          await provider.wait(`resume:${cycle}:stream`);
          const resumeRequest = provider.calls.findLast(
            (call) => call.cycle === cycle && call.name === "stream",
          );
          expect
            .soft(
              resumeRequest?.current,
              "the newly admitted turn must carry the standard resume input",
            )
            .toContain(RESUME);
          // Admission must finish while the resumed provider request is still held.
          await expect
            .soft(
              race(send(key(cycle, "stream"), fresh(cycle), "steer", { timeoutMs: 2_000 })),
              "a fresh message must not wait behind restart recovery admission",
            )
            .resolves.toMatchObject({ runId: expect.any(String) });
          provider.release(cycle);
          const expectedReplies: Array<{ name: Case; text: string }> = [
            ...cases
              .filter((name) => name !== "stream" && name !== "idle")
              .map((name) => ({ name, text: `RESUMED_${cycle}_${name}` })),
            { name: "stream", text: "HANDLED_LITERAL_STOP" },
            { name: "stream", text: `HANDLED_${queued(cycle, 2)}` },
            { name: "stream", text: `HANDLED_${fresh(cycle)}` },
          ];
          const completedReplies = await race(
            Promise.allSettled(
              expectedReplies.map(({ name, text }) => waitFinal(key(cycle, name), text)),
            ),
          );
          for (const [index, completion] of completedReplies.entries()) {
            expect
              .soft(completion, expectedReplies[index]?.text)
              .toMatchObject({ status: "fulfilled" });
          }
          const streamInputs = provider.calls
            .filter((call) => call.cycle === cycle && call.name === "stream")
            .map((call) => call.current);
          const firstQueued = streamInputs.findIndex((input) =>
            input.includes(LITERAL_QUEUED_COMMAND),
          );
          const secondQueued = streamInputs.findIndex((input) => input.includes(queued(cycle, 2)));
          expect
            .soft(firstQueued, "the first pre-restart queued input must follow resume")
            .toBeGreaterThan(streamInputs.findIndex((input) => input.includes(RESUME)));
          expect
            .soft(secondQueued, "the second pre-restart queued input must follow the first")
            .toBeGreaterThan(firstQueued);
          for (const name of cases) {
            const calls = provider.calls.filter(
              (call) => call.cycle === cycle && call.name === name,
            );
            const resumes = calls.filter((call) => call.resumeInput);
            if (name === "background") {
              expect(resumes[0]?.current).toContain(
                "Background exec processes were stopped; rerun them if still needed.",
              );
            }
            expect(
              resumes,
              `${name}: ${JSON.stringify(calls.map((call) => call.current.slice(-4_000)))}`,
            ).toHaveLength(name === "idle" ? 0 : 1);
            const result = await history(key(cycle, name));
            expectCleanHistory(result.messages);
            expect(
              result.pendingInputs?.items.some((item) => item.state === "interrupted"),
            ).not.toBe(true);
          }
          expect(
            provider.calls.filter((call) => call.cycle === cycle && call.name === "child"),
          ).toHaveLength(1);
          const children = await client.request<{
            sessions: Array<{ key: string; status: string; hasActiveRun: boolean }>;
          }>("sessions.list", { spawnedBy: key(cycle, "parent") });
          expect(children.sessions).toHaveLength(1);
          expect(children.sessions[0]?.hasActiveRun).toBe(false);
          expect(["queued", "running", "interrupted"]).not.toContain(children.sessions[0]?.status);
          if (cycle === 1) {
            const summary = provider.summaries.find((request) => request.cycle === cycle);
            const resume = provider.calls.find(
              (request) =>
                request.cycle === cycle && request.name === "compact" && request.resumeInput,
            );
            expect(summary?.ordinal).toBeLessThan(resume?.ordinal ?? 0);
          }
        }
        provider.prepare();
        const crashKey = key(2, "stream");
        await client.request("sessions.create", { key: crashKey, agentId: "other" });
        await send(crashKey, marker(2, "stream"));
        await provider.wait("ready:2:stream");
        await send(crashKey, CRASH_QUEUED, "followup");
        await waitQueued(crashKey, [CRASH_QUEUED]);
        await instance.crashGateway();
        await client.stopAndWait();
        client = undefined;
        provider.restart();
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await send(crashKey, AFTER_CRASH);
        await waitFinal(crashKey, `HANDLED_${AFTER_CRASH}`);
        expect(
          provider.calls.filter((call) => call.cycle === 2 && call.current.includes(RESUME)),
        ).toEqual([]);
        const crashHistory = await history(crashKey);
        expectCleanHistory(crashHistory.messages);
        provider.prepare();
        await send(crashKey, `${marker(2, "stream")} GRACEFUL_AFTER_CRASH`);
        await provider.wait("ready:graceful-after-crash");
        await send(crashKey, queued(2, 1), "followup");
        provider.restart();
        const child = instance.child;
        assert(child?.pid, "Owned Gateway process unavailable after crash");
        const closed = once(child, "close");
        const started = Date.now();
        expect(child.kill("SIGTERM")).toBe(true);
        expect(await race(closed), instance.logs()).toEqual([0, null]);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(
          readRestartSession(instance.state.agentDir(), key(1, "compact"), sharedStore)
            ?.compactionCount,
        ).toBeGreaterThan(0);
        await client.stopAndWait();
        client = undefined;
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await provider.wait("resume:2:stream");
        provider.release(2);
        await waitFinal(crashKey, `HANDLED_${queued(2, 1)}`);
        expect(provider.calls.some((call) => call.current.includes(CRASH_QUEUED))).toBe(false);
      },
      () => client?.stopAndWait(),
      provider.releaseFinalizer,
      () => instance.cleanup(),
      provider.close,
    );
  },
);
