import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function yieldToEventLoop() {
  // Avoid relying on timers (fake timers can leak between tests).
  await fs.stat(process.cwd()).catch(() => {});
}

async function rmTempDir(dir: string) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await yieldToEventLoop();
        continue;
      }
      throw err;
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function waitForNonEmptyFile(pathname: string, timeoutMs = 2000) {
  const startedAt = process.hrtime.bigint();
  for (;;) {
    const raw = await fs.readFile(pathname, "utf-8").catch(() => "");
    if (raw.trim().length > 0) {
      return raw;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`timeout waiting for file ${pathname}`);
    }
    await yieldToEventLoop();
  }
}

async function waitForCondition(check: () => boolean, timeoutMs = 2000) {
  const startedAt = process.hrtime.bigint();
  for (;;) {
    if (check()) {
      return;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs >= timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await yieldToEventLoop();
  }
}

describe("gateway server cron", () => {
  test("handles cron CRUD, normalization, and patch semantics", { timeout: 120_000 }, async () => {
    const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
    process.env.OPENCLAW_SKIP_CRON = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.sessionConfig = { mainKey: "primary" };
    testState.cronEnabled = false;
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(testState.cronStorePath, JSON.stringify({ version: 1, jobs: [] }));

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        name: "daily",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      expect(addRes.ok).toBe(true);
      expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe("string");

      const listRes = await rpcReq(ws, "cron.list", {
        includeDisabled: true,
      });
      expect(listRes.ok).toBe(true);
      const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs as unknown[]).length).toBe(1);
      expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe("daily");
      expect(
        ((jobs as Array<{ delivery?: { mode?: unknown } }>)[0]?.delivery?.mode as string) ?? "",
      ).toBe("webhook");

      const routeAtMs = Date.now() - 1;
      const routeRes = await rpcReq(ws, "cron.add", {
        name: "route test",
        enabled: true,
        schedule: { kind: "at", at: new Date(routeAtMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "cron route check" },
      });
      expect(routeRes.ok).toBe(true);
      const routeJobIdValue = (routeRes.payload as { id?: unknown } | null)?.id;
      const routeJobId = typeof routeJobIdValue === "string" ? routeJobIdValue : "";
      expect(routeJobId.length > 0).toBe(true);

      const runRes = await rpcReq(ws, "cron.run", { id: routeJobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      const events = await waitForSystemEvent();
      expect(events.some((event) => event.includes("cron route check"))).toBe(true);

      const wrappedAtMs = Date.now() + 1000;
      const wrappedRes = await rpcReq(ws, "cron.add", {
        data: {
          name: "wrapped",
          schedule: { at: new Date(wrappedAtMs).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      });
      expect(wrappedRes.ok).toBe(true);
      const wrappedPayload = wrappedRes.payload as
        | { schedule?: unknown; sessionTarget?: unknown; wakeMode?: unknown }
        | undefined;
      expect(wrappedPayload?.sessionTarget).toBe("main");
      expect(wrappedPayload?.wakeMode).toBe("now");
      expect((wrappedPayload?.schedule as { kind?: unknown } | undefined)?.kind).toBe("at");

      const patchRes = await rpcReq(ws, "cron.add", {
        name: "patch test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(patchRes.ok).toBe(true);
      const patchJobIdValue = (patchRes.payload as { id?: unknown } | null)?.id;
      const patchJobId = typeof patchJobIdValue === "string" ? patchJobIdValue : "";
      expect(patchJobId.length > 0).toBe(true);

      const atMs = Date.now() + 1_000;
      const updateRes = await rpcReq(ws, "cron.update", {
        id: patchJobId,
        patch: {
          schedule: { at: new Date(atMs).toISOString() },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(updateRes.ok).toBe(true);
      const updated = updateRes.payload as
        | { schedule?: { kind?: unknown }; payload?: { kind?: unknown } }
        | undefined;
      expect(updated?.schedule?.kind).toBe("at");
      expect(updated?.payload?.kind).toBe("systemEvent");

      const mergeRes = await rpcReq(ws, "cron.add", {
        name: "patch merge",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello", model: "opus" },
      });
      expect(mergeRes.ok).toBe(true);
      const mergeJobIdValue = (mergeRes.payload as { id?: unknown } | null)?.id;
      const mergeJobId = typeof mergeJobIdValue === "string" ? mergeJobIdValue : "";
      expect(mergeJobId.length > 0).toBe(true);

      const mergeUpdateRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        },
      });
      expect(mergeUpdateRes.ok).toBe(true);
      const merged = mergeUpdateRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown; model?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown };
          }
        | undefined;
      expect(merged?.payload?.kind).toBe("agentTurn");
      expect(merged?.payload?.message).toBe("hello");
      expect(merged?.payload?.model).toBe("opus");
      expect(merged?.delivery?.mode).toBe("announce");
      expect(merged?.delivery?.channel).toBe("telegram");
      expect(merged?.delivery?.to).toBe("19098680");

      const modelOnlyPatchRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          payload: {
            model: "anthropic/claude-sonnet-4-5",
          },
        },
      });
      expect(modelOnlyPatchRes.ok).toBe(true);
      const modelOnlyPatched = modelOnlyPatchRes.payload as
        | {
            payload?: {
              kind?: unknown;
              message?: unknown;
              model?: unknown;
            };
          }
        | undefined;
      expect(modelOnlyPatched?.payload?.kind).toBe("agentTurn");
      expect(modelOnlyPatched?.payload?.message).toBe("hello");
      expect(modelOnlyPatched?.payload?.model).toBe("anthropic/claude-sonnet-4-5");

      const legacyDeliveryPatchRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          payload: {
            kind: "agentTurn",
            deliver: true,
            channel: "signal",
            to: "+15550001111",
            bestEffortDeliver: true,
          },
        },
      });
      expect(legacyDeliveryPatchRes.ok).toBe(true);
      const legacyDeliveryPatched = legacyDeliveryPatchRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown; bestEffort?: unknown };
          }
        | undefined;
      expect(legacyDeliveryPatched?.payload?.kind).toBe("agentTurn");
      expect(legacyDeliveryPatched?.payload?.message).toBe("hello");
      expect(legacyDeliveryPatched?.delivery?.mode).toBe("announce");
      expect(legacyDeliveryPatched?.delivery?.channel).toBe("signal");
      expect(legacyDeliveryPatched?.delivery?.to).toBe("+15550001111");
      expect(legacyDeliveryPatched?.delivery?.bestEffort).toBe(true);

      const rejectRes = await rpcReq(ws, "cron.add", {
        name: "patch reject",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(rejectRes.ok).toBe(true);
      const rejectJobIdValue = (rejectRes.payload as { id?: unknown } | null)?.id;
      const rejectJobId = typeof rejectJobIdValue === "string" ? rejectJobIdValue : "";
      expect(rejectJobId.length > 0).toBe(true);

      const rejectUpdateRes = await rpcReq(ws, "cron.update", {
        id: rejectJobId,
        patch: {
          payload: { kind: "agentTurn", message: "nope" },
        },
      });
      expect(rejectUpdateRes.ok).toBe(false);

      const jobIdRes = await rpcReq(ws, "cron.add", {
        name: "jobId test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(jobIdRes.ok).toBe(true);
      const jobIdValue = (jobIdRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const jobIdUpdateRes = await rpcReq(ws, "cron.update", {
        jobId,
        patch: {
          schedule: { at: new Date(Date.now() + 2_000).toISOString() },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(jobIdUpdateRes.ok).toBe(true);

      const disableRes = await rpcReq(ws, "cron.add", {
        name: "disable test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(disableRes.ok).toBe(true);
      const disableJobIdValue = (disableRes.payload as { id?: unknown } | null)?.id;
      const disableJobId = typeof disableJobIdValue === "string" ? disableJobIdValue : "";
      expect(disableJobId.length > 0).toBe(true);

      const disableUpdateRes = await rpcReq(ws, "cron.update", {
        id: disableJobId,
        patch: { enabled: false },
      });
      expect(disableUpdateRes.ok).toBe(true);
      const disabled = disableUpdateRes.payload as { enabled?: unknown } | undefined;
      expect(disabled?.enabled).toBe(false);
    } finally {
      ws.close();
      await server.close();
      await rmTempDir(dir);
      testState.cronStorePath = undefined;
      testState.sessionConfig = undefined;
      testState.cronEnabled = undefined;
      if (prevSkipCron === undefined) {
        delete process.env.OPENCLAW_SKIP_CRON;
      } else {
        process.env.OPENCLAW_SKIP_CRON = prevSkipCron;
      }
    }
  });

  test("writes cron run history and auto-runs due jobs", async () => {
    const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
    process.env.OPENCLAW_SKIP_CRON = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-log-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.cronEnabled = undefined;
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(testState.cronStorePath, JSON.stringify({ version: 1, jobs: [] }));

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const atMs = Date.now() - 1;
      const addRes = await rpcReq(ws, "cron.add", {
        name: "log test",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      const logPath = path.join(dir, "cron", "runs", `${jobId}.jsonl`);
      const raw = await waitForNonEmptyFile(logPath, 5000);
      const line = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      const last = JSON.parse(line ?? "{}") as {
        jobId?: unknown;
        action?: unknown;
        status?: unknown;
        summary?: unknown;
      };
      expect(last.action).toBe("finished");
      expect(last.jobId).toBe(jobId);
      expect(last.status).toBe("ok");
      expect(last.summary).toBe("hello");

      const runsRes = await rpcReq(ws, "cron.runs", { id: jobId, limit: 50 });
      expect(runsRes.ok).toBe(true);
      const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
      expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe("hello");

      const statusRes = await rpcReq(ws, "cron.status", {});
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath = typeof statusPayload?.storePath === "string" ? statusPayload.storePath : "";
      expect(storePath).toContain("jobs.json");

      const autoRes = await rpcReq(ws, "cron.add", {
        name: "auto run test",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() - 10).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "auto" },
      });
      expect(autoRes.ok).toBe(true);
      const autoJobIdValue = (autoRes.payload as { id?: unknown } | null)?.id;
      const autoJobId = typeof autoJobIdValue === "string" ? autoJobIdValue : "";
      expect(autoJobId.length > 0).toBe(true);

      await waitForNonEmptyFile(path.join(dir, "cron", "runs", `${autoJobId}.jsonl`), 5000);
      const autoEntries = (await rpcReq(ws, "cron.runs", { id: autoJobId, limit: 10 })).payload as
        | { entries?: Array<{ jobId?: unknown }> }
        | undefined;
      expect(Array.isArray(autoEntries?.entries)).toBe(true);
      const runs = autoEntries?.entries ?? [];
      expect(runs.at(-1)?.jobId).toBe(autoJobId);
    } finally {
      ws.close();
      await server.close();
      await rmTempDir(dir);
      testState.cronStorePath = undefined;
      testState.cronEnabled = undefined;
      if (prevSkipCron === undefined) {
        delete process.env.OPENCLAW_SKIP_CRON;
      } else {
        process.env.OPENCLAW_SKIP_CRON = prevSkipCron;
      }
    }
  }, 45_000);

  test("posts webhooks for delivery mode and legacy notify fallback only when summary exists", async () => {
    const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
    process.env.OPENCLAW_SKIP_CRON = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-webhook-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.cronEnabled = false;
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });

    const legacyNotifyJob = {
      id: "legacy-notify-job",
      name: "legacy notify job",
      enabled: true,
      notify: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "legacy webhook" },
      state: {},
    };
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [legacyNotifyJob] }),
    );

    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    expect(typeof configPath).toBe("string");
    await fs.mkdir(path.dirname(configPath as string), { recursive: true });
    await fs.writeFile(
      configPath as string,
      JSON.stringify(
        {
          cron: {
            webhook: "https://legacy.example.invalid/cron-finished",
            webhookToken: "cron-webhook-token",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const invalidWebhookRes = await rpcReq(ws, "cron.add", {
        name: "invalid webhook",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "invalid" },
        delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
      });
      expect(invalidWebhookRes.ok).toBe(false);

      const notifyRes = await rpcReq(ws, "cron.add", {
        name: "webhook enabled",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "send webhook" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      expect(notifyRes.ok).toBe(true);
      const notifyJobIdValue = (notifyRes.payload as { id?: unknown } | null)?.id;
      const notifyJobId = typeof notifyJobIdValue === "string" ? notifyJobIdValue : "";
      expect(notifyJobId.length > 0).toBe(true);

      const notifyRunRes = await rpcReq(ws, "cron.run", { id: notifyJobId, mode: "force" }, 20_000);
      expect(notifyRunRes.ok).toBe(true);

      await waitForCondition(() => fetchMock.mock.calls.length === 1, 5000);
      const [notifyUrl, notifyInit] = fetchMock.mock.calls[0] as [
        string,
        {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ];
      expect(notifyUrl).toBe("https://example.invalid/cron-finished");
      expect(notifyInit.method).toBe("POST");
      expect(notifyInit.headers?.Authorization).toBe("Bearer cron-webhook-token");
      expect(notifyInit.headers?.["Content-Type"]).toBe("application/json");
      const notifyBody = JSON.parse(notifyInit.body ?? "{}");
      expect(notifyBody.action).toBe("finished");
      expect(notifyBody.jobId).toBe(notifyJobId);

      const legacyRunRes = await rpcReq(
        ws,
        "cron.run",
        { id: "legacy-notify-job", mode: "force" },
        20_000,
      );
      expect(legacyRunRes.ok).toBe(true);
      await waitForCondition(() => fetchMock.mock.calls.length === 2, 5000);
      const [legacyUrl, legacyInit] = fetchMock.mock.calls[1] as [
        string,
        {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ];
      expect(legacyUrl).toBe("https://legacy.example.invalid/cron-finished");
      expect(legacyInit.method).toBe("POST");
      expect(legacyInit.headers?.Authorization).toBe("Bearer cron-webhook-token");
      const legacyBody = JSON.parse(legacyInit.body ?? "{}");
      expect(legacyBody.action).toBe("finished");
      expect(legacyBody.jobId).toBe("legacy-notify-job");

      const silentRes = await rpcReq(ws, "cron.add", {
        name: "webhook disabled",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "do not send" },
      });
      expect(silentRes.ok).toBe(true);
      const silentJobIdValue = (silentRes.payload as { id?: unknown } | null)?.id;
      const silentJobId = typeof silentJobIdValue === "string" ? silentJobIdValue : "";
      expect(silentJobId.length > 0).toBe(true);

      const silentRunRes = await rpcReq(ws, "cron.run", { id: silentJobId, mode: "force" }, 20_000);
      expect(silentRunRes.ok).toBe(true);
      await yieldToEventLoop();
      await yieldToEventLoop();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      cronIsolatedRun.mockResolvedValueOnce({ status: "ok" });
      const noSummaryRes = await rpcReq(ws, "cron.add", {
        name: "webhook no summary",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      expect(noSummaryRes.ok).toBe(true);
      const noSummaryJobIdValue = (noSummaryRes.payload as { id?: unknown } | null)?.id;
      const noSummaryJobId = typeof noSummaryJobIdValue === "string" ? noSummaryJobIdValue : "";
      expect(noSummaryJobId.length > 0).toBe(true);

      const noSummaryRunRes = await rpcReq(
        ws,
        "cron.run",
        { id: noSummaryJobId, mode: "force" },
        20_000,
      );
      expect(noSummaryRunRes.ok).toBe(true);
      await yieldToEventLoop();
      await yieldToEventLoop();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      ws.close();
      await server.close();
      await rmTempDir(dir);
      vi.unstubAllGlobals();
      testState.cronStorePath = undefined;
      testState.cronEnabled = undefined;
      if (prevSkipCron === undefined) {
        delete process.env.OPENCLAW_SKIP_CRON;
      } else {
        process.env.OPENCLAW_SKIP_CRON = prevSkipCron;
      }
    }
  }, 60_000);
});
