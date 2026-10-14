import { expect } from "vitest";
import type WebSocket from "ws";
import { onceMessage, rpcReq } from "./test-helpers.js";

export const CRON_WAIT_TIMEOUT_MS = 10_000;

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
