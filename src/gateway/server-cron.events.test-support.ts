import { assert, expect, vi } from "vitest";
import type WebSocket from "ws";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { prewarmReplyRunRuntimes } from "../auto-reply/reply/get-reply-run-helpers.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRuntimeConfig } from "../config/config.js";
import type { CronJobCreate } from "../cron/types.js";
import type { GatewayCronState } from "./server-cron-contract.js";
import {
  gatewayReplyMock,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";

// mock-isolation: Keep real reply admission and settlement; only provider inference is synthetic.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));

const CRON_WAIT_TIMEOUT_MS = 10_000;

export async function cleanupCronTestRun(params: {
  ws?: { close: () => void };
  server?: { close: () => Promise<void> };
  cronState?: Pick<GatewayCronState, "cron">;
  prevSkipCron: string | undefined;
}) {
  params.ws?.close();
  await params.server?.close();
  if (params.cronState) {
    const { cron } = params.cronState;
    assert(typeof cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
    await cron.stopAndDrain();
  }
  testState.cronStorePath = undefined;
  testState.cronEnabled = undefined;
  testState.cronTriggersEnabled = undefined;
  if (params.prevSkipCron === undefined) {
    delete process.env.OPENCLAW_SKIP_CRON;
    return;
  }
  process.env.OPENCLAW_SKIP_CRON = params.prevSkipCron;
}

export function makeCronJob(name: string, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "hello" },
    ...overrides,
  };
}

/** Minimal Gateway fixtures execute scheduled events through ordinary reply admission. */
export async function installCronSystemEventConsumer(summary = "hello") {
  await prepareGatewayReplyRuntimeForTest({ force: true });
  // Match production readiness; the minimal Gateway fixture mocks its warmup hook.
  await prewarmReplyRunRuntimes();
  const model = vi.mocked(runEmbeddedAgent);
  const previousReply = gatewayReplyMock.getMockImplementation();
  const previousModel = model.getMockImplementation();
  gatewayReplyMock.mockImplementation((ctx, options, cfg) =>
    getReplyFromConfig(ctx, options, withFullRuntimeReplyConfig(cfg ?? getRuntimeConfig())),
  );
  model.mockImplementation(async (params) => {
    assert(params.preparedRunAdmission, "expected ordinary scheduled reply admission");
    await params.preparedRunAdmission.admit("gateway", params.runId);
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return {
      payloads: [{ text: summary }],
      meta: { durationMs: 1, terminalReply: { disposition: "visible", text: summary } },
    };
  });
  return () => {
    gatewayReplyMock.mockReset();
    model.mockReset();
    if (previousReply) {
      gatewayReplyMock.mockImplementation(previousReply);
    }
    if (previousModel) {
      model.mockImplementation(previousModel);
    }
  };
}

export async function waitForCronEvent(
  ws: WebSocket,
  check: (payload: Record<string, unknown> | null) => boolean,
  timeoutMs = CRON_WAIT_TIMEOUT_MS,
) {
  const message = await onceMessage(
    ws,
    (obj) => {
      const payload = obj.payload ?? null;
      return obj.type === "event" && obj.event === "cron" && check(payload);
    },
    timeoutMs,
  );
  return message.payload ?? null;
}

export function expectEnqueuedRunPayload(payload: unknown): string {
  const record = payload as { ok?: unknown; enqueued?: unknown; runId?: unknown } | null;
  expect(record?.ok).toBe(true);
  expect(record?.enqueued).toBe(true);
  expect(typeof record?.runId).toBe("string");
  return record?.runId as string;
}

export async function runCronJobAndWaitForFinished(ws: WebSocket, jobId: string) {
  const finished = waitForCronEvent(
    ws,
    (payload) => payload?.jobId === jobId && payload?.action === "finished",
  );
  const response = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000);
  expect(response.ok).toBe(true);
  expectEnqueuedRunPayload(response.payload);
  return await finished;
}
