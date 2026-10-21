import { expect } from "vitest";
import type WebSocket from "ws";
import type { CronJobCreate } from "../cron/types.js";
import { onceMessage, rpcReq } from "./test-helpers.js";

const CRON_WAIT_TIMEOUT_MS = 10_000;

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

/** Minimal Gateway fixtures need a session consumer before Cron can finish. */
export async function installCronSystemEventConsumer() {
  const [{ drainFormattedSystemEvents }, { getRuntimeConfig }, { setHeartbeatWakeHandler }] =
    await Promise.all([
      import("../auto-reply/reply/session-system-events.js"),
      import("../config/config.js"),
      import("../infra/heartbeat-wake.js"),
    ]);
  return setHeartbeatWakeHandler(async ({ source, agentId, sessionKey }) => {
    if (source !== "cron") {
      return { status: "skipped", reason: "no-pending-event" };
    }
    if (!agentId || !sessionKey) {
      throw new Error("Cron wake did not resolve its session owner");
    }
    await drainFormattedSystemEvents({
      cfg: getRuntimeConfig(),
      agentId,
      sessionKey,
      isMainSession: true,
      isNewSession: false,
    });
    return { status: "ran", durationMs: 0 };
  });
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
