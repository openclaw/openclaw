import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { CronJob } from "../../../../src/cron/types.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import type { GatewaySchedulerClock } from "../../../../src/infra/gateway-scheduler.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
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
import { isolatedGatewayEnv, messageText } from "./gateway-recovery.test-support.js";

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
type CronEvent = {
  action: string;
  jobId: string;
  status?: string;
  error?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  nextRunAtMs?: number;
};

// Only the host clock is replaced, using the existing Gateway startup seam.
// Transport, scheduler dispatch, admission, model execution, and actions stay real.
const schedulerClock = vi.hoisted(() => ({
  current: undefined as GatewaySchedulerClock | undefined,
}));
vi.mock("../../../../src/infra/gateway-scheduler.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: schedulerClock.current ?? options.clock });
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
}
beforeEach(resetGatewayState);
afterEach(() => {
  schedulerClock.current = undefined;
  resetGatewayState();
});

function toolOutput(body: ProviderRequest, callId: string): string {
  const output = body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === "call_" + callId,
  )?.output;
  if (output === undefined) {
    throw new Error("Missing production tool result: " + callId);
  }
  return output;
}

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

// This complements the mocked-runner authority matrix: real model tool calls,
// authenticated ingress, detached timer admission, rearm, and durable output.
// GitHub's real action owner is reached, but no publication/identity is invented:
// the no-publication verdict below is NOT proof of publication or successful landing.
it(
  "continues an authenticated conversation after disconnect and rearms only its original job",
  {
    timeout: 90_000,
  },
  async ({ signal }) => {
    const home = tempDirs.make("openclaw-authorized-continuation-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all(
      [stateDir, workspaceDir, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const token = randomUUID();
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const continuation = "Continue the authorized task in this conversation.";
    const waiting = "Authorized continuation will check again.";
    const completed = "Authorized continuation completed.";
    const clock = createGatewaySchedulerClock(Date.now());
    schedulerClock.current = clock.clock;
    const firstFinished = createDeferred<CronEvent>();
    const removed = createDeferred<CronEvent>();
    const providerFailure = createDeferred<Error>();
    const observe = <T>(work: Promise<T>) =>
      withinTest(
        Promise.race([
          work,
          providerFailure.promise.then((error): never => {
            throw error;
          }),
        ]),
        signal,
      );
    const events: CronEvent[] = [];
    let creatorDisconnected = false;
    let step = 0;
    let jobId: string | undefined;
    let creator: GatewayClient | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const envPatch = {
      ...isolatedGatewayEnv,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      // The synthetic model is in this process, never behind the host proxy.
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const envSnapshot = captureEnv([
      ...Object.keys(envPatch),
      "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
      "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    ]);
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === undefined) {
        deleteTestEnvValue(key);
      } else {
        setTestEnvValue(key, value);
      }
    }
    let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    try {
      provider = await startOpenAiResponsesModelServer({
        modelId: "qa-authorized-continuation",
        bindError: "continuation provider did not bind",
        onRequest: async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
            const reply = (text: string) =>
              writeOpenAiResponsesText(response, {
                text,
                messageId: "message-" + step,
                responseId: "response-" + step,
              });
            const instructions = JSON.stringify([
              body.instructions,
              ...body.input.filter((item) => item.role === "developer" || item.role === "system"),
            ]);
            if (instructions.includes("Generate a concise session title")) {
              reply("Authorized continuation proof");
              return;
            }
            switch (step++) {
              case 0:
                writeToolCall(response, "automations", "create", {
                  action: "add",
                  job: {
                    name: "Authorized continuation transport proof",
                    schedule: {
                      kind: "at",
                      at: new Date(clock.clock.now() + 60_000).toISOString(),
                    },
                    sessionTarget: "session:" + sessionKey,
                    payload: {
                      kind: "agentTurn",
                      message: continuation,
                      toolsAllow: ["sessions", "github_publish", "automations"],
                    },
                    delivery: { mode: "none" },
                  },
                });
                break;
              case 1: {
                const job = JSON.parse(toolOutput(body, "create")) as CronJob;
                expect(job).toMatchObject({ sessionTarget: "session:" + sessionKey });
                expect(job.id).toEqual(expect.any(String));
                jobId = job.id;
                reply("Authorized continuation scheduled.");
                break;
              }
              case 2:
                expect(creatorDisconnected).toBe(true);
                expect(JSON.stringify(body.input)).toContain(continuation);
                writeToolCall(response, "github_publish", "inspect", { action: "inspect" });
                break;
              case 3:
                // This exact owner verdict follows the current operator-write guard.
                // A missing tool, schema-only offer, or authorization error cannot pass.
                expect(toolOutput(body, "inspect")).toContain(
                  "This session has no completed shared publication.",
                );
                writeToolCall(response, "sessions", "pin", { action: "patch", pinned: true });
                break;
              case 4:
                expect(JSON.parse(toolOutput(body, "pin"))).toMatchObject({
                  status: "updated",
                  sessionKey,
                });
                writeToolCall(response, "automations", "rearm", { action: "next_check", in: "5s" });
                break;
              case 5:
                expect(JSON.parse(toolOutput(body, "rearm"))).toMatchObject({
                  ok: true,
                  delayMs: 5_000,
                });
                reply(waiting);
                break;
              case 6:
                expect(JSON.stringify(body.input)).toContain(waiting);
                writeToolCall(response, "sessions", "finish", {
                  action: "patch",
                  pinned: false,
                  statusNote: completed,
                });
                break;
              case 7:
                expect(JSON.parse(toolOutput(body, "finish"))).toMatchObject({
                  status: "updated",
                  sessionKey,
                });
                reply(completed);
                break;
              default:
                throw new Error("Unexpected model request after continuation completion");
            }
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            providerFailure.resolve(failure);
            throw failure;
          }
        },
      });
      const modelConfig = createOpenAiResponsesModelConfig({
        baseUrl: provider.baseUrl,
        providerId: "mock-openai",
        modelId: "qa-authorized-continuation",
        reasoning: false,
        toolProfile: "full",
      });
      const config: OpenClawConfig = {
        ...modelConfig,
        agents: {
          ...modelConfig.agents,
          defaults: {
            ...modelConfig.agents?.defaults,
            workspace: workspaceDir,
            models: {
              "mock-openai/qa-authorized-continuation": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          entries: { main: {} },
        },
        tools: {
          allow: ["automations", "sessions", "github_publish"],
          toolSearch: { enabled: false },
        },
        gateway: { auth: { mode: "token", token } },
      };
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token,
        origin: "http://127.0.0.1",
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        scopes: ["operator.admin"],
        onEvent: (event) => {
          if (event.event !== "cron") {
            return;
          }
          const cron = event.payload as CronEvent;
          events.push(cron);
          if (cron.jobId !== jobId) {
            return;
          }
          if (cron.action === "finished") {
            firstFinished.resolve(cron);
            if (cron.status !== "ok") {
              providerFailure.resolve(new Error(cron.error ?? "Scheduled continuation failed"));
            }
          }
          if (cron.action === "removed") {
            removed.resolve(cron);
          }
        },
      });
      await gateway.server.startupSettled;
      // Startup dispatch may own background work waiting on a later clock wake.
      // The scheduler retains those joins; server.close drains them below.
      void clock.advanceBy(500);
      const runtimeConfig = getRuntimeConfigSnapshot();
      if (!runtimeConfig) {
        throw new Error("Gateway runtime config was not initialized");
      }
      withFastReplyConfig(runtimeConfig);
      const observer = gateway.client;
      await observer.request("sessions.subscribe", {});
      creator = await connectGatewayClient({
        url: "ws://127.0.0.1:" + gateway.port,
        token,
        origin: "http://127.0.0.1",
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        scopes: ["operator.admin"],
      });
      const started = await creator.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "Schedule the authorized continuation.",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      const initialRun = await observe(
        creator.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      );
      expect(initialRun, `Initial run stopped at provider step ${step}`).toMatchObject({
        status: "ok",
      });
      expect(jobId).toBeDefined();
      const before = await observer.request<CronJob>("cron.get", { id: jobId });
      expect(before).toMatchObject({
        id: jobId,
        sessionTarget: "session:" + sessionKey,
        enabled: true,
      });
      const originalSession = (
        await observer.request<SessionsListResult>("sessions.list", {})
      ).sessions.find((row) => row.key === sessionKey);
      expect(originalSession?.sessionId).toEqual(expect.any(String));
      await disconnectGatewayClient(creator);
      creator = undefined;
      creatorDisconnected = true;
      // Expire the original deadline after its creating run and socket have ended.
      // Editing the schedule here would retire the captured source.
      expect(before.schedule.kind).toBe("at");
      if (before.schedule.kind !== "at") {
        throw new Error("Expected a one-shot continuation");
      }
      void clock.advanceTo(Date.parse(before.schedule.at));
      const first = await observe(firstFinished.promise);
      expect(first, first.error).toMatchObject({ status: "ok", jobId, sessionKey });
      const rearmed = await observer.request<CronJob>("cron.get", { id: jobId });
      expect(rearmed).toMatchObject({
        id: jobId,
        enabled: true,
        payload: before.payload,
        sessionTarget: before.sessionTarget,
        schedule: before.schedule,
      });
      expect(rearmed.state.nextRunAtMs).toEqual(expect.any(Number));
      const pinned = (
        await observer.request<SessionsListResult>("sessions.list", {})
      ).sessions.find((row) => row.key === sessionKey);
      expect(pinned).toMatchObject({ sessionId: originalSession?.sessionId, pinned: true });
      const nextRunAtMs = rearmed.state.nextRunAtMs;
      if (nextRunAtMs === undefined) {
        throw new Error("Continuation was not rearmed");
      }
      void clock.advanceTo(nextRunAtMs);
      await observe(removed.promise);
      expect(step).toBe(8);
      const runs = await observer.request<{
        entries: Array<{ status: string; sessionKey?: string; sessionId?: string }>;
      }>("cron.runs", { id: jobId });
      expect(runs.entries).toHaveLength(2);
      for (const run of runs.entries) {
        expect(run).toMatchObject({
          status: "ok",
          sessionKey,
          sessionId: originalSession?.sessionId,
        });
      }
      expect(
        events.filter((event) => event.jobId === jobId && event.action === "added"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.jobId === jobId && event.action === "finished"),
      ).toHaveLength(2);
      expect(
        (await observer.request<{ jobs: CronJob[] }>("cron.list", { includeDisabled: true })).jobs,
      ).not.toContainEqual(expect.objectContaining({ id: jobId }));
      // Read after reconnect, not from the model response or live UI event cache.
      await disconnectGatewayClient(observer);
      gateway.client = await connectGatewayClient({
        url: "ws://127.0.0.1:" + gateway.port,
        token,
        scopes: ["operator.admin"],
      });
      const finalSession = (
        await gateway.client.request<SessionsListResult>("sessions.list", {})
      ).sessions.find((row) => row.key === sessionKey);
      expect(finalSession).toMatchObject({
        sessionId: originalSession?.sessionId,
        pinned: false,
        agentStatus: { note: completed },
      });
      const history = await gateway.client.request<{
        sessionId: string;
        messages: Array<{ role?: string; content?: unknown }>;
      }>("chat.history", { sessionKey });
      expect(history.sessionId).toBe(originalSession?.sessionId);
      const replies = history.messages
        .filter((message) => message.role === "assistant")
        .map(messageText);
      expect(replies.filter((text) => text === waiting)).toHaveLength(1);
      expect(replies.filter((text) => text === completed)).toHaveLength(1);
    } finally {
      if (creator) {
        await disconnectGatewayClient(creator);
      }
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Authorized continuation E2E complete" });
      }
      await provider?.close();
      envSnapshot.restore();
    }
  },
);
