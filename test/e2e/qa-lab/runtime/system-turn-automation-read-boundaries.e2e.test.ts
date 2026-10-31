import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { captureCronSchedulerWakeForTest } from "../../../../src/cron/service/scheduler-actor.test-support.js";
import type { CronJob } from "../../../../src/cron/types.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import type { GatewaySchedulerClock } from "../../../../src/infra/gateway-scheduler.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createGatewaySchedulerClock } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";
import { resetGatewayState } from "./gateway-startup-routing.test-support.js";

type ProviderRequest = {
  instructions?: string;
  input: Array<{
    role?: string;
    type?: string;
    call_id?: string;
    output?: string;
    content?: unknown;
  }>;
};
type CronEvent = { action: string; jobId: string; status?: string };
type RunsOutcome = { id?: string; ok?: boolean; payload?: unknown; threw?: string };

// Seams observe or pause the production read; scheduling, admission, the
// scheduler's caller scope, and tool execution stay real. Only model HTTP is synthetic.
const seams = vi.hoisted(() => ({
  clock: undefined as GatewaySchedulerClock | undefined,
  hold: undefined as { held: () => void; release: Promise<void> } | undefined,
  runsOutcomes: [] as RunsOutcome[],
  onRunsOutcome: undefined as ((outcome: RunsOutcome) => void) | undefined,
}));
vi.mock("../../../../src/infra/gateway-scheduler.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: seams.clock ?? options.clock });
      }
    },
  };
});
// Pause after history hydration, before the handler's disclosure-time recheck.
vi.mock("../../../../src/cron/store/read-only.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/cron/store/read-only.js")>();
  return {
    ...actual,
    readCronRunHistoryRecords: async (
      ...args: Parameters<typeof actual.readCronRunHistoryRecords>
    ) => {
      const records = await actual.readCronRunHistoryRecords(...args);
      const hold = seams.hold;
      seams.hold = undefined;
      if (hold) {
        hold.held();
        await hold.release;
      }
      return records;
    },
  };
});
// Record what the production cron.runs handler actually disclosed.
vi.mock("../../../../src/gateway/server-methods/cron-runs.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/gateway/server-methods/cron-runs.js")>();
  return {
    ...actual,
    cronRunsHandler: async (options: Parameters<typeof actual.cronRunsHandler>[0]) => {
      const params = options.params as { id?: string; jobId?: string };
      const outcome: RunsOutcome = { id: params.id ?? params.jobId };
      try {
        return await actual.cronRunsHandler({
          ...options,
          respond: (ok, payload, error, meta) => {
            outcome.ok = ok;
            outcome.payload = ok ? payload : error;
            options.respond(ok, payload, error, meta);
          },
        });
      } catch (error) {
        outcome.threw = String(error);
        throw error;
      } finally {
        seams.runsOutcomes.push(outcome);
        seams.onRunsOutcome?.(outcome);
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetGatewayState);
afterEach(() => {
  seams.clock = undefined;
  seams.hold = undefined;
  seams.runsOutcomes.length = 0;
  seams.onRunsOutcome = undefined;
  resetGatewayState();
});

function writeToolCall(
  response: ServerResponse,
  name: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: "fc_" + callId,
    call_id: "call_" + callId,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + callId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

/** A scheduled run's prompt (`[cron:<id> <name>] <message>`), never a tool result. */
function isScheduledRun(body: ProviderRequest): boolean {
  return body.input.some(
    (item) =>
      item.role === "user" &&
      JSON.stringify(item.content).includes("[cron:") &&
      JSON.stringify(item.content).includes("RUN-MARKER-"),
  );
}

it(
  "serves an automation notice turn only its own automation reads at the final effect",
  { timeout: 240_000 },
  async ({ signal, onTestFinished }) => {
    const home = tempDirs.make("openclaw-system-turn-read-boundaries-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([stateDir, workspaceDir].map((dir) => fs.mkdir(dir, { recursive: true })));
    const token = randomUUID();
    const controlUi = {
      origin: "http://127.0.0.1",
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      scopes: ["operator.admin"],
    };
    const ownedSession = "agent:main:dashboard:" + randomUUID();
    const foreignSession = "agent:main:dashboard:" + randomUUID();
    const clock = createGatewaySchedulerClock(Date.now());
    seams.clock = clock.clock;
    const failure = createDeferred<Error>();
    const observe = <T>(work: Promise<T>) =>
      withinTest(
        Promise.race([
          work,
          failure.promise.then((error): never => {
            throw error;
          }),
        ]),
        signal,
      );
    const outputs = new Map<string, string>();
    const jobs: { owned?: CronJob; closing?: CronJob; foreign?: CronJob } = {};
    const finished = new Map<string, ReturnType<typeof createDeferred<CronEvent>>>();
    const finishedFor = (id: string) => {
      const entry = finished.get(id) ?? createDeferred<CronEvent>();
      finished.set(id, entry);
      return entry.promise;
    };
    const firstNoticeDone = createDeferred();
    const closingNoticeHeld = createDeferred();
    const forgedDone = createDeferred();
    let releaseHold: () => void = () => {};
    let lateNoticeRequest: string | undefined;
    const holdNextHistoryRead = () => {
      const held = createDeferred();
      const release = createDeferred();
      releaseHold = () => release.resolve();
      seams.hold = { held: () => held.resolve(), release: release.promise };
      return held.promise;
    };
    const removalHeld = createDeferred();
    let step = 0;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let nonOwner: GatewayClient | undefined;
    let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    const proofJob = (name: string, marker: string, delayMs: number) => ({
      action: "add",
      job: {
        name,
        // Default target: the creating chat runs it and receives its notices.
        schedule: { kind: "at", at: new Date(clock.clock.now() + delayMs).toISOString() },
        payload: { kind: "agentTurn", message: marker },
        delivery: { mode: "none" },
      },
    });
    const env = {
      ...isolatedGatewayEnv,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const scenario = withEnvAsync(env, async () => {
      try {
        provider = await startOpenAiResponsesModelServer({
          modelId: "qa-read-boundaries",
          bindError: "provider bind failed",
          onRequest: async (request, response) => {
            try {
              const body = JSON.parse(await readBody(request)) as ProviderRequest;
              const reply = (text: string) =>
                writeOpenAiResponsesText(response, {
                  text,
                  messageId: "m-" + step,
                  responseId: "r-" + step,
                });
              if (JSON.stringify(body).includes("Generate a concise session title")) {
                reply("Read boundary proof");
                return;
              }
              // The scheduled run itself fails, as in production, so the scheduler
              // auto-disables the one-shot and notifies its owning conversation.
              if (isScheduledRun(body)) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                  JSON.stringify({
                    error: { message: "proof model rejected the run", type: "invalid_request" },
                  }),
                );
                return;
              }
              const lastOutput = body.input.at(-1);
              if (lastOutput?.type === "function_call_output" && lastOutput.call_id) {
                outputs.set(lastOutput.call_id.replace(/^call_/, ""), lastOutput.output ?? "");
              }
              const call = (name: string, callId: string, args: Record<string, unknown>) =>
                writeToolCall(response, name, callId, args);
              const owned = () => jobs.owned!.id;
              switch (step++) {
                // Owner turn in the owned chat creates two one-shot automations.
                case 0:
                  call("automations", "add_owned", proofJob("Owned proof", "RUN-MARKER-A", 60_000));
                  break;
                case 1:
                  jobs.owned = JSON.parse(outputs.get("add_owned")!) as CronJob;
                  call(
                    "automations",
                    "add_closing",
                    proofJob("Closing proof", "RUN-MARKER-C", 120_000),
                  );
                  break;
                case 2:
                  jobs.closing = JSON.parse(outputs.get("add_closing")!) as CronJob;
                  reply("Scheduled.");
                  break;
                // Owner turn in another chat creates the foreign automation.
                case 3:
                  call(
                    "automations",
                    "add_foreign",
                    proofJob("Foreign proof", "RUN-MARKER-B", 3_600_000),
                  );
                  break;
                case 4:
                  jobs.foreign = JSON.parse(outputs.get("add_foreign")!) as CronJob;
                  reply("Scheduled.");
                  break;
                // The scheduler's real auto-disable notice turn for the failed owned automation.
                case 5:
                  expect(JSON.stringify(body.input)).toContain(
                    'Automation \\"Owned proof\\" was auto-disabled after 1 consecutive run failures.',
                  );
                  call("automations", "get_owned", { action: "get", jobId: owned() });
                  break;
                case 6:
                  // Fail fast on the owner gate instead of waiting on later reads.
                  expect(outputs.get("get_owned")).not.toContain("needs the owner's authority");
                  call("automations", "runs_owned", { action: "runs", jobId: owned() });
                  break;
                case 7:
                  call("automations", "get_foreign", { action: "get", jobId: jobs.foreign!.id });
                  break;
                case 8:
                  call("automations", "runs_foreign", { action: "runs", jobId: jobs.foreign!.id });
                  break;
                case 9:
                  call("automations", "list", { action: "list", includeDisabled: true });
                  break;
                case 10:
                  call("automations", "update", {
                    action: "update",
                    jobId: owned(),
                    patch: { enabled: true },
                  });
                  break;
                case 11:
                  call("automations", "remove", { action: "remove", jobId: owned() });
                  break;
                case 12:
                  call("automations", "add", proofJob("Notice-created", "RUN-MARKER-X", 60_000));
                  break;
                case 13:
                  call("automations", "run", { action: "run", jobId: owned() });
                  break;
                case 14:
                  call("automations", "status", { action: "status" });
                  break;
                case 15:
                  call("gateway", "gateway", { action: "config.get" });
                  break;
                case 16:
                  void holdNextHistoryRead().then(() => removalHeld.resolve());
                  call("automations", "runs_removed", { action: "runs", jobId: owned() });
                  break;
                case 17:
                  reply("Automation history inspected.");
                  firstNoticeDone.resolve();
                  break;
                // The second notice turn's read is closed before disclosure.
                case 18: {
                  expect(JSON.stringify(body.input)).toContain(
                    'Automation \\"Closing proof\\" was auto-disabled',
                  );
                  void holdNextHistoryRead().then(() => closingNoticeHeld.resolve());
                  call("automations", "runs_closed", { action: "runs", jobId: jobs.closing!.id });
                  break;
                }
                // A non-owner client's agent turn that asserts scheduler provenance.
                case 19:
                  if (lastOutput?.call_id === "call_runs_closed") {
                    lateNoticeRequest = lastOutput.output;
                    step--;
                    reply("Stopped.");
                    break;
                  }
                  call("automations", "forged_get", { action: "get", jobId: jobs.closing!.id });
                  break;
                case 20:
                  reply("Done.");
                  forgedDone.resolve();
                  break;
                default:
                  throw new Error("Unexpected provider request " + step);
              }
            } catch (error) {
              failure.resolve(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
          },
        });
        const cfg = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId: "qa-read-boundaries",
          reasoning: false,
          toolProfile: "full",
        });
        cfg.agents!.defaults!.workspace = workspaceDir;
        cfg.agents!.defaults!.models = {
          "mock-openai/qa-read-boundaries": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        };
        cfg.agents!.entries = { main: {} };
        cfg.tools = { allow: ["automations", "gateway"], codeMode: false, toolSearch: false };
        cfg.gateway = { auth: { mode: "token", token } };
        // No failure-alert route: a failed one-shot's owner gets the in-app auto-disable notice.
        cfg.cron = { failureAlert: { enabled: false } };
        await fs.writeFile(configPath, JSON.stringify(cfg));
        const cronScheduler = await captureCronSchedulerWakeForTest(async (wakeRegistered) => {
          const started = await startGatewayWithClient({
            cfg,
            configPath,
            token,
            ...controlUi,
            beforeConnect: async (server) => {
              await server.startupSettled;
              // Client admission waits for post-ready work on this manual clock.
              void clock.advanceBy(500);
              await observe(wakeRegistered);
            },
            onEvent: (event) => {
              const cron = event.event === "cron" ? (event.payload as CronEvent) : undefined;
              if (cron?.action === "finished") {
                void finishedFor(cron.jobId);
                finished.get(cron.jobId)!.resolve(cron);
              }
            },
          });
          gateway = started;
          // Cold startup must not leave new one-shot timestamps in the real past.
          clock.setTime(Date.now());
          return started;
        });
        const live = cronScheduler.result;
        const runtime = getRuntimeConfigSnapshot();
        assert(runtime);
        withFastReplyConfig(runtime);
        const ownerTurn = async (sessionKey: string, message: string) => {
          const { runId } = await live.client.request<{ runId: string }>("chat.send", {
            sessionKey,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          await observe(
            live.client.request("agent.wait", { runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 }),
          );
        };
        await ownerTurn(ownedSession, "Schedule the owned proofs.");
        await ownerTurn(foreignSession, "Schedule the foreign proof.");
        assert(jobs.owned && jobs.closing && jobs.foreign, "Owner turns did not create the jobs");

        const runDue = async (job: CronJob) => {
          assert(job.schedule.kind === "at");
          void clock.advanceTo(Date.parse(job.schedule.at));
          cronScheduler.notify();
          return await observe(finishedFor(job.id));
        };
        expect(await runDue(jobs.owned)).toMatchObject({ status: "error" });
        // The operator removes the automation while the notice turn's awaited history read is in flight.
        await observe(removalHeld.promise);
        await live.client.request("cron.remove", { id: jobs.owned.id });
        releaseHold();
        await observe(firstNoticeDone.promise);

        expect(await runDue(jobs.closing)).toMatchObject({ status: "error" });
        // The notice run closes while its awaited history read is in flight.
        await observe(closingNoticeHeld.promise);
        const closed = createDeferred<RunsOutcome>();
        seams.onRunsOutcome = (outcome) => closed.resolve(outcome);
        await live.client.request("chat.abort", { sessionKey: ownedSession });
        releaseHold();
        const closedOutcome = await observe(closed.promise);

        nonOwner = await connectGatewayClient({
          url: "ws://127.0.0.1:" + live.port,
          token,
          scopes: ["operator.write"],
        });
        const { runId: forgedRunId } = await nonOwner.request<{ runId: string }>("agent", {
          message: "Automation history check.",
          agentId: "main",
          sessionKey: ownedSession,
          inputProvenance: { kind: "internal_system", sourceTool: "cron" },
          idempotencyKey: randomUUID(),
        });
        await observe(forgedDone.promise);
        await observe(
          nonOwner.request(
            "agent.wait",
            { runId: forgedRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        );

        // Owned reads disclose the owned automation and its failed run.
        expect(JSON.parse(outputs.get("get_owned")!)).toMatchObject({
          id: jobs.owned.id,
          name: "Owned proof",
          enabled: false,
        });
        const ownedRuns = JSON.parse(outputs.get("runs_owned")!) as {
          entries: Array<{ jobId: string; status: string }>;
        };
        expect(ownedRuns.entries).toEqual([
          expect.objectContaining({ jobId: jobs.owned.id, status: "error" }),
        ]);
        // Another chat's automation is indistinguishable from a missing one.
        for (const id of ["get_foreign", "runs_foreign"]) {
          expect(outputs.get(id)).toContain(`not found: ${jobs.foreign.id}`);
          expect(outputs.get(id)).not.toContain("Foreign proof");
          expect(outputs.get(id)).not.toContain("RUN-MARKER-B");
        }
        const inventory = JSON.parse(outputs.get("list")!) as {
          scope: string;
          jobs: Array<{ id: string }>;
        };
        expect(inventory.scope).toBe("caller");
        expect(inventory.jobs.map((job) => job.id).toSorted()).toEqual(
          [jobs.owned.id, jobs.closing.id].toSorted(),
        );
        // Every write and every other owner-only tool keeps the owner gate.
        for (const id of ["update", "remove", "add", "run", "status"]) {
          expect(outputs.get(id)).toContain("Other actions need the owner's authority");
        }
        expect(outputs.get("gateway")).toContain("gateway needs the owner's authority");
        // Removed during the awaited read: the disclosure-time recheck withholds history.
        expect(outputs.get("runs_removed")).toContain(`not found: ${jobs.owned.id}`);
        // Closed during the awaited read: the handler responds with nothing at all.
        expect(closedOutcome).toEqual({
          id: jobs.closing.id,
          threw: expect.stringContaining("agent runtime authority is no longer active"),
        });
        expect(lateNoticeRequest ?? "").not.toContain('"entries"');
        // Asserted scheduler provenance on a non-owner client turn unlocks nothing.
        expect(outputs.get("forged_get")).toContain("automations needs the owner's authority");
        const stillListed = await live.client.request<{ jobs: CronJob[] }>("cron.list", {
          includeDisabled: true,
        });
        expect(stillListed.jobs.map((job) => job.name).toSorted()).toEqual([
          "Closing proof",
          "Foreign proof",
        ]);
      } finally {
        try {
          if (nonOwner) {
            await disconnectGatewayClient(nonOwner);
          }
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "Read boundary proof complete" });
            }
          }
        } finally {
          await provider?.close();
        }
      }
    });
    onTestFinished(async () => {
      await Promise.allSettled([scenario]);
    });
    return scenario;
  },
);
