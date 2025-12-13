import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { startGatewayServer } from "./server.js";

let testSessionStorePath: string | undefined;
let testAllowFrom: string[] | undefined;
let testCronStorePath: string | undefined;
let testCronEnabled: boolean | undefined = false;
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    inbound: {
      allowFrom: testAllowFrom,
      reply: {
        mode: "command",
        command: ["echo", "ok"],
        session: { mainKey: "main", store: testSessionStorePath },
      },
    },
    cron: (() => {
      const cron: Record<string, unknown> = {};
      if (typeof testCronEnabled === "boolean") cron.enabled = testCronEnabled;
      if (typeof testCronStorePath === "string") cron.store = testCronStorePath;
      return Object.keys(cron).length > 0 ? cron : undefined;
    })(),
  }),
}));

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../webchat/server.js", () => ({
  ensureWebChatServerFromConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock("../web/outbound.js", () => ({
  sendMessageWhatsApp: vi
    .fn()
    .mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

process.env.CLAWDIS_SKIP_PROVIDERS = "1";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(String(data));
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj as T);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

async function startServerWithClient(token?: string) {
  const port = await getFreePort();
  const prev = process.env.CLAWDIS_GATEWAY_TOKEN;
  if (token === undefined) {
    delete process.env.CLAWDIS_GATEWAY_TOKEN;
  } else {
    process.env.CLAWDIS_GATEWAY_TOKEN = token;
  }
  const server = await startGatewayServer(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return { server, ws, port, prevToken: prev };
}

type ConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

async function connectReq(
  ws: WebSocket,
  opts?: {
    token?: string;
    minProtocol?: number;
    maxProtocol?: number;
    client?: {
      name: string;
      version: string;
      platform: string;
      mode: string;
      instanceId?: string;
    };
  },
): Promise<ConnectResponse> {
  const id = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: opts?.minProtocol ?? PROTOCOL_VERSION,
        maxProtocol: opts?.maxProtocol ?? PROTOCOL_VERSION,
        client: opts?.client ?? {
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
        },
        caps: [],
        auth: opts?.token ? { token: opts.token } : undefined,
      },
    }),
  );
  return await onceMessage<ConnectResponse>(
    ws,
    (o) => o.type === "res" && o.id === id,
  );
}

async function connectOk(
  ws: WebSocket,
  opts?: Parameters<typeof connectReq>[1],
) {
  const res = await connectReq(ws, opts);
  expect(res.ok).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe(
    "hello-ok",
  );
  return res.payload as { type: "hello-ok" };
}

describe("gateway server", () => {
  test("supports cron.add and cron.list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-cron-"));
    testCronStorePath = path.join(dir, "cron.json");
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-1",
        method: "cron.add",
        params: {
          name: "daily",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );
    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-1");
    expect(addRes.ok).toBe(true);
    expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe(
      "string",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-list-1",
        method: "cron.list",
        params: { includeDisabled: true },
      }),
    );
    const listRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-list-1");
    expect(listRes.ok).toBe(true);
    const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
    expect(Array.isArray(jobs)).toBe(true);
    expect((jobs as unknown[]).length).toBe(1);
    expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe(
      "daily",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("writes cron run history for flat store paths", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-log-"),
    );
    testCronStorePath = path.join(dir, "cron.json");
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-log-1",
        method: "cron.add",
        params: {
          enabled: true,
          schedule: { kind: "at", atMs },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );

    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-log-1");
    expect(addRes.ok).toBe(true);
    const jobId = String((addRes.payload as { id?: unknown } | null)?.id ?? "");
    expect(jobId.length > 0).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-run-log-1",
        method: "cron.run",
        params: { id: jobId, mode: "force" },
      }),
    );
    const runRes = await onceMessage<{ type: "res"; ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === "cron-run-log-1",
      8000,
    );
    expect(runRes.ok).toBe(true);

    const logPath = path.join(dir, "cron.runs.jsonl");
    const waitForLog = async () => {
      for (let i = 0; i < 200; i++) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for cron run log");
    };

    const raw = await waitForLog();
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines.at(-1) ?? "{}") as {
      jobId?: unknown;
      action?: unknown;
      status?: unknown;
    };
    expect(last.action).toBe("finished");
    expect(last.jobId).toBe(jobId);
    expect(last.status).toBe("ok");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-runs-1",
        method: "cron.runs",
        params: { id: jobId, limit: 50 },
      }),
    );
    const runsRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-runs-1", 8000);
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("writes cron run history to per-job runs/ when store is jobs.json", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-log-jobs-"),
    );
    const cronDir = path.join(dir, "cron");
    testCronStorePath = path.join(cronDir, "jobs.json");
    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-log-2",
        method: "cron.add",
        params: {
          enabled: true,
          schedule: { kind: "at", atMs },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );

    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-log-2");
    expect(addRes.ok).toBe(true);
    const jobId = String((addRes.payload as { id?: unknown } | null)?.id ?? "");
    expect(jobId.length > 0).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-run-log-2",
        method: "cron.run",
        params: { id: jobId, mode: "force" },
      }),
    );
    const runRes = await onceMessage<{ type: "res"; ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === "cron-run-log-2",
      8000,
    );
    expect(runRes.ok).toBe(true);

    const logPath = path.join(cronDir, "runs", `${jobId}.jsonl`);
    const waitForLog = async () => {
      for (let i = 0; i < 200; i++) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for per-job cron run log");
    };

    const raw = await waitForLog();
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const last = JSON.parse(line ?? "{}") as {
      jobId?: unknown;
      action?: unknown;
    };
    expect(last.action).toBe("finished");
    expect(last.jobId).toBe(jobId);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-runs-2",
        method: "cron.runs",
        params: { id: jobId, limit: 20 },
      }),
    );
    const runsRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-runs-2", 8000);
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("enables cron scheduler by default and runs due jobs automatically", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-default-on-"),
    );
    testCronStorePath = path.join(dir, "cron.json");
    testCronEnabled = undefined; // omitted config => enabled by default

    try {
      await fs.writeFile(
        testCronStorePath,
        JSON.stringify({ version: 1, jobs: [] }),
      );

      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      ws.send(
        JSON.stringify({
          type: "req",
          id: "cron-status-1",
          method: "cron.status",
          params: {},
        }),
      );
      const statusRes = await onceMessage<{
        type: "res";
        id: string;
        ok: boolean;
        payload?: unknown;
      }>(ws, (o) => o.type === "res" && o.id === "cron-status-1");
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      expect(String(statusPayload?.storePath ?? "")).toContain("cron.json");

      const atMs = Date.now() + 80;
      ws.send(
        JSON.stringify({
          type: "req",
          id: "cron-add-auto-1",
          method: "cron.add",
          params: {
            enabled: true,
            schedule: { kind: "at", atMs },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "auto" },
          },
        }),
      );
      const addRes = await onceMessage<{
        type: "res";
        ok: boolean;
        payload?: unknown;
      }>(ws, (o) => o.type === "res" && o.id === "cron-add-auto-1");
      expect(addRes.ok).toBe(true);
      const jobId = String(
        (addRes.payload as { id?: unknown } | null)?.id ?? "",
      );
      expect(jobId.length > 0).toBe(true);

      const finishedEvt = await onceMessage<{
        type: "event";
        event: string;
        payload?: { jobId?: string; action?: string; status?: string } | null;
      }>(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "cron" &&
          (o.payload as { jobId?: unknown } | null)?.jobId === jobId &&
          (o.payload as { action?: unknown } | null)?.action === "finished",
        8000,
      );
      expect(finishedEvt.payload?.status).toBe("ok");

      const waitForRuns = async () => {
        for (let i = 0; i < 200; i++) {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "cron-runs-auto-1",
              method: "cron.runs",
              params: { id: jobId, limit: 10 },
            }),
          );
          const runsRes = await onceMessage<{
            type: "res";
            ok: boolean;
            payload?: unknown;
          }>(ws, (o) => o.type === "res" && o.id === "cron-runs-auto-1", 8000);
          expect(runsRes.ok).toBe(true);
          const entries = (runsRes.payload as { entries?: unknown } | null)
            ?.entries;
          if (Array.isArray(entries) && entries.length > 0) return entries;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("timeout waiting for cron.runs entries");
      };

      const entries = (await waitForRuns()) as Array<{ jobId?: unknown }>;
      expect(entries.at(-1)?.jobId).toBe(jobId);

      ws.close();
      await server.close();
    } finally {
      testCronEnabled = false;
      testCronStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("broadcasts heartbeat events and serves last-heartbeat", async () => {
    type HeartbeatPayload = {
      ts: number;
      status: string;
      to?: string;
      preview?: string;
      durationMs?: number;
      hasMedia?: boolean;
      reason?: string;
    };
    type EventFrame = {
      type: "event";
      event: string;
      payload?: HeartbeatPayload | null;
    };
    type ResFrame = {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
    };

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitHeartbeat = onceMessage<EventFrame>(
      ws,
      (o) => o.type === "event" && o.event === "heartbeat",
    );
    emitHeartbeatEvent({ status: "sent", to: "+123", preview: "ping" });
    const evt = await waitHeartbeat;
    expect(evt.payload?.status).toBe("sent");
    expect(typeof evt.payload?.ts).toBe("number");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-last",
        method: "last-heartbeat",
      }),
    );
    const last = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-last",
    );
    expect(last.ok).toBe(true);
    const lastPayload = last.payload as HeartbeatPayload | null | undefined;
    expect(lastPayload?.status).toBe("sent");
    expect(lastPayload?.ts).toBe(evt.payload?.ts);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-toggle-off",
        method: "set-heartbeats",
        params: { enabled: false },
      }),
    );
    const toggle = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-toggle-off",
    );
    expect(toggle.ok).toBe(true);
    expect((toggle.payload as { enabled?: boolean } | undefined)?.enabled).toBe(
      false,
    );

    ws.close();
    await server.close();
  });

  test("agent falls back to allowFrom when lastTo is stale", async () => {
    testAllowFrom = ["+436769770569"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-stale",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-stale",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-stale",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-stale",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+436769770569");
    expect(call.sessionId).toBe("sess-main-stale");

    ws.close();
    await server.close();
    testAllowFrom = undefined;
  });

  test("agent routes main last-channel whatsapp", async () => {
    testAllowFrom = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-whatsapp",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-whatsapp",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-whatsapp",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-whatsapp",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-whatsapp");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel telegram", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-last");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("telegram");
    expect(call.to).toBe("123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main");

    ws.close();
    await server.close();
  });

  test("agent ignores webchat last-channel for routing", async () => {
    testAllowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-webchat",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-webchat",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-webchat",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-webchat");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat");

    ws.close();
    await server.close();
  });

  test("rejects protocol mismatch", async () => {
    const { server, ws } = await startServerWithClient();
    try {
      const res = await connectReq(ws, {
        minProtocol: PROTOCOL_VERSION + 1,
        maxProtocol: PROTOCOL_VERSION + 2,
      });
      expect(res.ok).toBe(false);
    } catch {
      // If the server closed before we saw the frame, that's acceptable for mismatch.
    }
    ws.close();
    await server.close();
  });

  test("rejects invalid token", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");
    ws.close();
    await server.close();
    process.env.CLAWDIS_GATEWAY_TOKEN = prevToken;
  });

  test(
    "closes silent handshakes after timeout",
    { timeout: 15_000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 12_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      await server.close();
    },
  );

  test("connect (req) handshake returns hello-ok payload", async () => {
    const { server, ws } = await startServerWithClient();
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        },
      }),
    );

    const res = await onceMessage<{ ok: boolean; payload?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === id,
    );
    expect(res.ok).toBe(true);
    expect((res.payload as { type?: unknown } | undefined)?.type).toBe(
      "hello-ok",
    );
    ws.close();
    await server.close();
  });

  test("rejects non-connect first request", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
    const res = await onceMessage<{ ok: boolean; error?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === "h1",
    );
    expect(res.ok).toBe(false);
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await server.close();
  });

  test(
    "connect + health + presence + status succeed",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const healthP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "health1",
      );
      const statusP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "status1",
      );
      const presenceP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "presence1",
      );

      const sendReq = (id: string, method: string) =>
        ws.send(JSON.stringify({ type: "req", id, method }));
      sendReq("health1", "health");
      sendReq("status1", "status");
      sendReq("presence1", "system-presence");

      const health = await healthP;
      const status = await statusP;
      const presence = await presenceP;
      expect(health.ok).toBe(true);
      expect(status.ok).toBe(true);
      expect(presence.ok).toBe(true);
      expect(Array.isArray(presence.payload)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test(
    "presence events carry seq + stateVersion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const presenceEventP = onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "presence",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "evt-1",
          method: "system-event",
          params: { text: "note from test" },
        }),
      );

      const evt = await presenceEventP;
      expect(typeof evt.seq).toBe("number");
      expect(evt.stateVersion?.presence).toBeGreaterThan(0);
      expect(Array.isArray(evt.payload?.presence)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("agent events stream with seq", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    // Emit a fake agent event directly through the shared emitter.
    const runId = randomUUID();
    const evtPromise = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "agent" &&
        o.payload?.runId === runId &&
        o.payload?.stream === "job",
    );
    emitAgentEvent({ runId, stream: "job", data: { msg: "hi" } });
    const evt = await evtPromise;
    expect(evt.payload.runId).toBe(runId);
    expect(typeof evt.seq).toBe("number");
    expect(evt.payload.data.msg).toBe("hi");

    ws.close();
    await server.close();
  });

  test(
    "agent ack response then final response",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const ackP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status === "accepted",
      );
      const finalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "idem-ag" },
        }),
      );

      const ack = await ackP;
      const final = await finalP;
      expect(ack.payload.runId).toBeDefined();
      expect(final.payload.runId).toBe(ack.payload.runId);
      expect(final.payload.status).toBe("ok");

      ws.close();
      await server.close();
    },
  );

  test(
    "agent dedupes by idempotencyKey after completion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const firstFinalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "same-agent" },
        }),
      );
      const firstFinal = await firstFinalP;

      const secondP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "ag2",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag2",
          method: "agent",
          params: { message: "hi again", idempotencyKey: "same-agent" },
        }),
      );
      const second = await secondP;
      expect(second.payload).toEqual(firstFinal.payload);

      ws.close();
      await server.close();
    },
  );

  test("shutdown event is broadcast on close", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      5000,
    );
    await server.close();
    const evt = await shutdownP;
    expect(evt.payload?.reason).toBeDefined();
  });

  test(
    "presence broadcast reaches multiple clients",
    { timeout: 8000 },
    async () => {
      const port = await getFreePort();
      const server = await startGatewayServer(port);
      const mkClient = async () => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve) => c.once("open", resolve));
        await connectOk(c);
        return c;
      };

      const clients = await Promise.all([mkClient(), mkClient(), mkClient()]);
      const waits = clients.map((c) =>
        onceMessage(c, (o) => o.type === "event" && o.event === "presence"),
      );
      clients[0].send(
        JSON.stringify({
          type: "req",
          id: "broadcast",
          method: "system-event",
          params: { text: "fanout" },
        }),
      );
      const events = await Promise.all(waits);
      for (const evt of events) {
        expect(evt.payload?.presence?.length).toBeGreaterThan(0);
        expect(typeof evt.seq).toBe("number");
      }
      for (const c of clients) c.close();
      await server.close();
    },
  );

  test("send dedupes by idempotencyKey", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const idem = "same-key";
    const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
    const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
    const sendReq = (id: string) =>
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "send",
          params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
        }),
      );
    sendReq("a1");
    sendReq("a2");

    const res1 = await res1P;
    const res2 = await res2P;
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.payload).toEqual(res2.payload);
    ws.close();
    await server.close();
  });

  test("agent dedupe survives reconnect", { timeout: 15000 }, async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const dial = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await connectOk(ws);
      return ws;
    };

    const idem = "reconnect-agent";
    const ws1 = await dial();
    const final1P = onceMessage(
      ws1,
      (o) =>
        o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
      6000,
    );
    ws1.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: idem },
      }),
    );
    const final1 = await final1P;
    ws1.close();

    const ws2 = await dial();
    const final2P = onceMessage(
      ws2,
      (o) =>
        o.type === "res" && o.id === "ag2" && o.payload?.status !== "accepted",
      6000,
    );
    ws2.send(
      JSON.stringify({
        type: "req",
        id: "ag2",
        method: "agent",
        params: { message: "hi again", idempotencyKey: idem },
      }),
    );
    const res = await final2P;
    expect(res.payload).toEqual(final1.payload);
    ws2.close();
    await server.close();
  });

  test("chat.send accepts image attachment", { timeout: 12000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const reqId = "chat-img";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "see image",
          idempotencyKey: "idem-img",
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
            },
          ],
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.runId).toBeDefined();

    ws.close();
    await server.close();
  });

  test("chat.send does not overwrite last delivery route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const reqId = "chat-route";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-route",
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
    );
    expect(res.ok).toBe(true);

    const stored = JSON.parse(
      await fs.readFile(testSessionStorePath, "utf-8"),
    ) as {
      main?: { lastChannel?: string; lastTo?: string };
    };
    expect(stored.main?.lastChannel).toBe("whatsapp");
    expect(stored.main?.lastTo).toBe("+1555");

    ws.close();
    await server.close();
  });

  test("presence includes client fingerprint", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        name: "fingerprint",
        version: "9.9.9",
        platform: "test",
        mode: "ui",
        instanceId: "abc",
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "fingerprint",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "fingerprint",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    const clientEntry = entries.find((e) => e.instanceId === "abc");
    expect(clientEntry?.host).toBe("fingerprint");
    expect(clientEntry?.version).toBe("9.9.9");
    expect(clientEntry?.mode).toBe("ui");

    ws.close();
    await server.close();
  });

  test("cli connections are not tracked as instances", async () => {
    const { server, ws } = await startServerWithClient();
    const cliId = `cli-${randomUUID()}`;
    await connectOk(ws, {
      client: {
        name: "cli",
        version: "dev",
        platform: "test",
        mode: "cli",
        instanceId: cliId,
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "cli-presence",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cli-presence",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.instanceId === cliId)).toBe(false);

    ws.close();
    await server.close();
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port } = await occupyPort();
    await expect(startGatewayServer(port)).rejects.toBeInstanceOf(
      GatewayLockError,
    );
    await expect(startGatewayServer(port)).rejects.toThrow(
      /already listening/i,
    );
    blocker.close();
  });

  test("releases port after close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    // If the port was released, another listener can bind immediately.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
