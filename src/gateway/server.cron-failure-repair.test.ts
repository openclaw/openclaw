// A failing owned job's repair runs as an ordinary owner-conversation turn, never a heartbeat.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { saveCronStore } from "../cron/store.js";
import {
  agentCommandMock,
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function runAndWaitForFinished(ws: WebSocket, jobId: string) {
  const finished = onceMessage(
    ws,
    (obj) =>
      obj.type === "event" &&
      obj.event === "cron" &&
      obj.payload?.jobId === jobId &&
      obj.payload?.action === "finished",
    10_000,
  );
  expect((await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000)).ok).toBe(true);
  await finished;
}

test("repairs an owned job with an ordinary owner-topic turn whatever the heartbeat config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-repair-"));
  const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
  process.env.OPENCLAW_SKIP_CRON = "0";
  cleanups.push(async () => {
    if (prevSkipCron === undefined) {
      delete process.env.OPENCLAW_SKIP_CRON;
    } else {
      process.env.OPENCLAW_SKIP_CRON = prevSkipCron;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  testState.cronStorePath = path.join(dir, "cron", "jobs.json");
  await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
  await saveCronStore(testState.cronStorePath, { version: 1, jobs: [] });
  const group = "-100155462274";
  const ownerSessionKey = `agent:main:telegram:group:${group}:topic:42`;
  const hour = new Date().getUTCHours();
  // Our production heartbeat shape: none of it may apply to the repair turn.
  testState.agentConfig = {
    heartbeat: {
      every: "1h",
      target: "none",
      isolatedSession: true,
      lightContext: true,
      activeHours: {
        start: `${String((hour + 2) % 24).padStart(2, "0")}:00`,
        end: `${String((hour + 3) % 24).padStart(2, "0")}:00`,
        timezone: "UTC",
      },
    },
  };
  testState.sessionStorePath = path.join(dir, "sessions.json");
  await writeSessionStore({
    agentId: "main",
    entries: {
      [ownerSessionKey]: {
        sessionId: "owner-topic-session",
        updatedAt: Date.now(),
        chatType: "group",
        deliveryContext: { channel: "telegram", to: group, threadId: 42 },
        lastChannel: "telegram",
        lastTo: group,
        lastThreadId: 42,
      },
    },
  });
  const { server, ws } = await startServerWithClient();
  cleanups.push(async () => {
    ws.close();
    await server.close();
  });
  await connectOk(ws);
  await prepareGatewayReplyRuntimeForTest({ force: true });
  cronIsolatedRun.mockResolvedValue({ status: "error", error: "scripts/sync.md is missing" });
  const added = await rpcReq(ws, "cron.add", {
    name: "meeting sync",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Follow scripts/sync.md." },
    delivery: { mode: "announce", channel: "telegram", to: group, threadId: 42 },
    owner: { agentId: "main", sessionKey: ownerSessionKey },
  });
  expect(added.ok, JSON.stringify(added.error ?? null)).toBe(true);
  const jobPayload = added.payload;
  const jobId =
    jobPayload && typeof jobPayload === "object" && "id" in jobPayload ? String(jobPayload.id) : "";
  expect(jobId).not.toBe("");

  await runAndWaitForFinished(ws, jobId);
  await runAndWaitForFinished(ws, jobId);

  await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
  // The owner topic's own session and route: no `:heartbeat` side session, no dropped reply.
  expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
    sessionKey: ownerSessionKey,
    deliver: true,
    channel: "telegram",
    to: group,
    threadId: 42,
    message: expect.stringContaining("Automation repair request from the scheduler"),
  });
  expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
}, 45_000);
