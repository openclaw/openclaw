import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants, existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import type { CostUsageSummary } from "../src/infra/session-cost-usage.types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  readRestartSession,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartToolCall,
  writeRestartJsonText,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type Lane = { lane: string; activeCount: number; queuedCount: number; maxConcurrent: number };

/** Real graceful restart, public cron RPCs, deterministic external model service. */
export async function measureRestartLaneFlood(options: {
  signal: AbortSignal;
  cwd?: string;
  entrypoint?: string[];
  fixture?: string;
  count?: number;
  serviceMs?: number;
  output?: string;
  onProgress?: (phase: string) => void;
  profileDir?: string;
}) {
  const count = options.count ?? 40;
  const serviceMs = options.serviceMs ?? 1_000;
  const initialReady = createDeferredCore();
  const firstResumed = createDeferredCore();
  const release = createDeferredCore();
  const completed = createDeferredCore();
  const failure = createDeferredCore<never>();
  void failure.promise.catch(() => {});
  const calls: Array<{
    kind: "initial" | "resume" | "cron";
    id: number;
    at: number;
    completedResumes: number;
  }> = [];
  const submitted = new Map<number, number>();
  const declared = new Set<number>();
  const finishedResumes: number[] = [];
  let resumed = false;
  let epoch = 0;
  let finished = 0;
  let ordinal = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal: options.signal,
    createListener: () =>
      restartProviderServer(
        failure,
        async (_request, response, body) => {
          const text = JSON.stringify(body.input);
          const cron = /LANE_CRON_(\d+)/.exec(text);
          const chat = /LANE_RESUME_(\d+)/.exec(text);
          const id = Number((cron ?? chat)?.[1]);
          const responseId = ++ordinal;
          if ((!cron && !chat) || restartToolNames(body).length === 0) {
            if (body.stream === false) {
              writeRestartJsonText(response, "Synthetic lane session", String(responseId));
            } else {
              writeOpenAiResponsesText(response, {
                text: "Synthetic lane session",
                responseId: `r${responseId}`,
                messageId: `m${responseId}`,
              });
            }
            return;
          }
          const kind = cron ? "cron" : resumed ? "resume" : "initial";
          if (kind !== "cron" || !declared.has(id)) {
            calls.push({
              kind,
              id,
              at: performance.now(),
              completedResumes: finishedResumes.length,
            });
          }
          if (kind === "initial") {
            if (calls.filter((call) => call.kind === "initial").length === count) {
              initialReady.resolve();
            }
            return;
          }
          if (kind === "resume") {
            assert(text.includes("The Gateway restarted while you were working."));
            firstResumed.resolve();
            await release.promise;
            await delay(serviceMs, undefined, { signal: options.signal });
            finishedResumes.push(id);
          }
          if (kind === "cron" && !declared.has(id)) {
            declared.add(id);
            const tools = restartToolNames(body);
            const toolName = tools.includes("cron") ? "cron" : "dispatch_action";
            assert(tools.includes(toolName), "Scheduled run must expose its result tool");
            const args = {
              action: "record_result",
              outcome: "done",
              summary: `LANE_DONE_cron_${id}`,
            };
            writeRestartToolCall(
              response,
              `cron-${id}`,
              toolName,
              toolName === "cron" ? args : { id: "cron", args },
              responseId,
            );
            return;
          }
          writeOpenAiResponsesText(response, {
            text: `LANE_DONE_${kind}_${id}`,
            responseId: `r${responseId}`,
            messageId: `m${responseId}`,
          });
          finished++;
          if (finished === count + 12) {
            completed.resolve();
          }
        },
        { ignoreAborted: true },
      ),
  });
  const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`);
  const workspace = options.fixture ? path.join(options.fixture, "workspace") : undefined;
  const config = {
    ...restartModelConfig(model, workspace, { maxConcurrent: count, timeoutSeconds: 120 }),
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    plugins: { enabled: false },
    cron: { enabled: true },
    hooks: { enabled: false },
    tools: { allow: ["cron"], codeMode: { enabled: false } },
    diagnostics: { enabled: true },
  };
  const instance = await createOpenClawTestInstance({
    name: "restart-lane-flood",
    cwd: options.cwd,
    entrypoint: options.profileDir
      ? [
          "--import",
          new URL("../scripts/tsx.mjs", import.meta.url).pathname,
          "--import",
          new URL("../scripts/perf/restart-lane-metrics.ts", import.meta.url).pathname,
          ...(options.entrypoint ?? ["dist/entry.js"]),
        ]
      : options.entrypoint,
    config,
    state: { layout: "split" },
    env: {
      ...restartEnv,
      OPENCLAW_NO_RESPAWN: "1",
      ...(options.profileDir ? { OPENCLAW_PERF_RESTART_METRICS_DIR: options.profileDir } : {}),
    },
    signal: options.signal,
    startTimeoutMs: 180_000,
    gracefulShutdownTimeoutMs: options.fixture ? 180_000 : 20_000,
  });
  const keys = Array.from({ length: count }, (_, id) => `agent:main:dashboard:lane-resume-${id}`);
  let client: GatewayClient | undefined;
  let fixtureWarmupMs = 0;
  let lanes: Lane[] = [];
  const wait = <T>(value: Promise<T>) =>
    withinTest(Promise.race([value, failure.promise]), options.signal);
  const captureProfile = async () => {
    if (!options.profileDir) {
      return;
    }
    const pid = instance.child?.pid;
    assert(pid);
    process.kill(pid, "SIGWINCH");
    while (!existsSync(path.join(options.profileDir, `${pid}.json`))) {
      await delay(10, undefined, { signal: options.signal });
    }
  };
  try {
    if (options.fixture) {
      await mkdir(instance.state.agentDir(), { recursive: true });
      const fixtureAgentDir = path.join(options.fixture, "agents", "main", "agent");
      if (process.platform === "darwin") {
        // Node's best-effort reflink falls back to a full 35 GiB copy on macOS.
        execFileSync("/bin/cp", ["-cR", `${fixtureAgentDir}/.`, instance.state.agentDir()]);
      } else {
        await cp(fixtureAgentDir, instance.state.agentDir(), {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
        });
      }
    }
    await instance.startGateway();
    options.onProgress?.("initial gateway ready");
    client = await connectRestartClient(
      instance,
      { deviceAuthScope: instance.url, sharedStateMode: "read-only" },
      options.signal,
    );
    options.onProgress?.("initial client connected");
    if (options.fixture) {
      const started = performance.now();
      // Finish cold fixture backfill before interrupting the measured turns.
      for (;;) {
        const usage: CostUsageSummary = await wait(
          client.request<CostUsageSummary>(
            "usage.cost",
            { agentId: "main" },
            { timeoutMs: 300_000 },
          ),
        );
        options.onProgress?.(`fixture usage ${JSON.stringify(usage.cacheStatus)}`);
        if (usage.cacheStatus?.status === "fresh") {
          break;
        }
        await delay(1_000, undefined, { signal: options.signal });
      }
      fixtureWarmupMs = performance.now() - started;
      options.onProgress?.(`fixture usage ready after ${Math.round(fixtureWarmupMs)}ms`);
    }
    const jobs: string[] = [];
    for (let id = 0; id < 12; id++) {
      const job = await client.request<{ id: string }>("cron.add", {
        name: `Synthetic arrival ${id}`,
        agentId: "main",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: `LANE_CRON_${id}`, timeoutSeconds: 60 },
        delivery: { mode: "none" },
      });
      jobs.push(job.id);
    }
    await Promise.all(
      keys.map(async (key, id) => {
        await client!.request("sessions.create", { key, agentId: "main" });
        await client!.request(
          "chat.send",
          { sessionKey: key, message: `LANE_RESUME_${id}`, idempotencyKey: randomUUID() },
          { expectFinal: false },
        );
      }),
    );
    await wait(initialReady.promise);
    options.onProgress?.("forty model requests interrupted");
    const child = instance.child;
    assert(child);
    await captureProfile();
    const closed = once(child, "close");
    assert(child.kill("SIGTERM"));
    assert.deepEqual(await wait(closed), [0, null]);
    await client.stopAndWait();
    client = undefined;
    for (const key of keys) {
      assert(
        readRestartSession(instance.state.agentDir(), key)?.resumeAfterRestart,
        `Missing restart marker: ${key}`,
      );
    }
    const saved = JSON.parse(await readFile(instance.configPath, "utf8"));
    saved.agents.defaults.maxConcurrent = 8;
    await instance.state.writeConfig(saved);
    resumed = true;
    epoch = performance.now();
    await instance.startGateway();
    options.onProgress?.("restarted gateway ready");
    client = await connectRestartClient(
      instance,
      { deviceAuthScope: instance.url, sharedStateMode: "read-only" },
      options.signal,
    );
    await wait(firstResumed.promise);
    for (;;) {
      ({ lanes } = await client.request<{ lanes: Lane[] }>("diagnostics.lanes", {}));
      if (
        lanes.reduce(
          (total, lane) =>
            total +
            (lane.lane === "cron-nested" || lane.lane === "restart-recovery"
              ? lane.activeCount + lane.queuedCount
              : 0),
          0,
        ) === count
      ) {
        break;
      }
      await delay(20, undefined, { signal: options.signal });
    }
    options.onProgress?.(
      `recovery admitted ${JSON.stringify(lanes.filter((lane) => lane.activeCount + lane.queuedCount > 0))}`,
    );
    const cronRuns: Promise<unknown>[] = [];
    for (const [id, jobId] of jobs.entries()) {
      submitted.set(id, performance.now());
      const run = client.request("cron.run", { id: jobId, mode: "force" }, { timeoutMs: 90_000 });
      void run.catch(() => {});
      cronRuns.push(run);
      if (id === 0) {
        release.resolve();
      }
      await delay(100, undefined, { signal: options.signal });
    }
    await wait(completed.promise);
    await wait(Promise.all(cronRuns));
    const cronOutcomes = [];
    for (const jobId of jobs) {
      for (;;) {
        const history: {
          entries: Array<{ status: string; summary?: string }>;
        } = await client.request("cron.runs", { id: jobId, limit: 1 });
        if (history.entries.length) {
          assert.equal(history.entries[0]?.status, "ok", JSON.stringify(history));
          cronOutcomes.push(history.entries[0]);
          break;
        }
        await delay(20, undefined, { signal: options.signal });
      }
    }
    for (const key of keys) {
      for (;;) {
        const history: {
          sessionInfo: { hasActiveRun: boolean };
          messages: unknown[];
        } = await client.request("chat.history", { sessionKey: key });
        if (!history.sessionInfo.hasActiveRun) {
          assert(JSON.stringify(history.messages).includes("LANE_DONE_resume_"));
          break;
        }
        await delay(20, undefined, { signal: options.signal });
      }
    }
    const quantiles = (values: number[]) => {
      values.sort((a, b) => a - b);
      return {
        samples: values.length,
        p50: values[Math.ceil(values.length * 0.5) - 1],
        p99: values[Math.ceil(values.length * 0.99) - 1],
        min: values[0],
        max: values.at(-1),
      };
    };
    const resumeCalls = calls.filter((call) => call.kind === "resume");
    assert.deepEqual(
      resumeCalls.map((call) => call.id).toSorted((a, b) => a - b),
      Array.from({ length: count }, (_, id) => id),
    );
    assert.deepEqual(
      [...declared].toSorted((a, b) => a - b),
      Array.from({ length: 12 }, (_, id) => id),
    );
    const first = Math.min(...resumeCalls.map((call) => call.at));
    await captureProfile();
    const result = {
      count,
      serviceMs,
      fixtureWarmupMs,
      cronOutcomes,
      lanesAtRecoveryAdmission: lanes,
      firstResumeAfterRestartMs: first - epoch,
      resumeDispatchFromFirstMs: quantiles(resumeCalls.map((call) => call.at - first)),
      newCronRequestToModelMs: quantiles(
        calls
          .filter((call) => call.kind === "cron")
          .map((call) => call.at - submitted.get(call.id)!),
      ),
      calls: calls
        .filter((call) => call.kind !== "initial")
        .map((call) => ({
          kind: call.kind,
          id: call.id,
          at: call.at - epoch,
          completedResumes: call.completedResumes,
        })),
    };
    if (options.output) {
      await writeFile(options.output, JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    if (options.output) {
      await writeFile(`${options.output}.failure.log`, instance.logs());
    }
    throw new Error(`${String(error)}\n${instance.logs().slice(-16_000)}`, { cause: error });
  } finally {
    release.resolve();
    await runQaGatewayFixture(
      async () => {},
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      async () => reservation.listener.closeAllConnections(),
      reservation.releaseListener,
      reservation.claim.release,
    );
  }
}
