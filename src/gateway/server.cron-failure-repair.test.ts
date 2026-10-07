// A failing owned job's repair runs as an ordinary owner-conversation turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import type WebSocket from "ws";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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

const group = "-100155462274";
const ownerSessionKey = `agent:main:telegram:group:${group}:topic:42`;
let dir: string;
let prevSkipCron: string | undefined;
let acquisition: ReturnType<typeof startServerWithClient> | undefined;
let preparation: Promise<void> | undefined;

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-repair-"));
    prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
    process.env.OPENCLAW_SKIP_CRON = "0";
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await saveCronStore(testState.cronStorePath, { version: 1, jobs: [] });
    acquisition = startServerWithClient();
    const { ws } = await acquisition;
    await connectOk(ws);
  },
  cleanup: async () => {
    await preparation?.catch(() => undefined);
    if (acquisition) {
      const { server, ws } = await acquisition;
      ws.close();
      await server.close();
    }
    if (prevSkipCron === undefined) {
      delete process.env.OPENCLAW_SKIP_CRON;
    } else {
      process.env.OPENCLAW_SKIP_CRON = prevSkipCron;
    }
    await fs.rm(dir, { recursive: true, force: true });
  },
});

beforeEach(
  () =>
    (preparation = (async () => {
      // The suite hook resets runtime selectors while retaining the serving Gateway.
      process.env.OPENCLAW_SKIP_CRON = "0";
      testState.cronStorePath = path.join(dir, "cron", "jobs.json");
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
      await prepareGatewayReplyRuntimeForTest({ force: true });
    })()),
);

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

test("repairs an isolated job with an ordinary owner-topic turn", async ({ signal }) => {
  if (!acquisition) {
    throw new Error("Gateway repair fixture was not acquired");
  }
  const { ws } = await acquisition;
  const repairTurnStarted = createDeferred();
  agentCommandMock.mockImplementationOnce(async () => {
    repairTurnStarted.resolve();
  });
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

  await withinTest(repairTurnStarted.promise, signal);
  expect(agentCommandMock).toHaveBeenCalledOnce();
  // The owner topic's own session and route: no `:heartbeat` side session, no dropped reply,
  // and only the turn's authored reply is delivered (no runtime timeout warning).
  expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
    sessionKey: ownerSessionKey,
    deliver: true,
    channel: "telegram",
    to: group,
    threadId: 42,
    message: expect.stringContaining("Automation repair request from the scheduler"),
    internalDeliverySuppressErrors: true,
  });
  expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
}, 45_000);
