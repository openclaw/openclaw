import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../../test/helpers/mock-logger.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { GatewayClientRequestError } from "../client.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-add-max-jobs-" });
const requireRecord = createRequireRecord("record", "expected-label-object");
const LIMIT_MESSAGE =
  "cron job limit reached: 1 of 1 jobs allowed by cron.maxJobs already exist; remove a job or update an existing one instead of adding another";

async function startCron() {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    cronConfig: { maxJobs: 1 },
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  onTestFinished(() => cron.stop());
  await cron.start();
  return { cron, storePath };
}

/** Runs the production `cron.add` handler against a real cron service. */
async function addOverGateway(cron: { cron: CronService; storePath: string }, params: unknown) {
  let response: { ok: boolean; payload?: unknown; error?: Parameters<RespondFn>[2] } | undefined;
  await expectDefined(
    cronHandlers["cron.add"],
    "cron.add handler",
  )({
    req: {} as never,
    params: requireRecord(params, "cron.add params"),
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    context: {
      cron: cron.cron,
      cronStorePath: cron.storePath,
      logGateway: createInfoWarnErrorLogger(),
      getRuntimeConfig: () => ({ cron: { maxJobs: 1 } }),
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return expectDefined(response, "cron.add response");
}

function reminder(name: string) {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: name },
  };
}

describe("cron.add at cron.maxJobs", () => {
  it("answers INVALID_REQUEST and leaves the store unchanged", async () => {
    const cron = await startCron();
    expect(await addOverGateway(cron, reminder("first"))).toMatchObject({ ok: true });

    const refused = await addOverGateway(cron, reminder("second"));

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `invalid cron.add params: ${LIMIT_MESSAGE}`,
    });
    const jobs = await cron.cron.list({ includeDisabled: true });
    expect(jobs.map((job) => job.name)).toEqual(["first"]);
  });

  it("relays the refusal to the agent automations tool without retrying", async () => {
    const cron = await startCron();
    const callGatewayTool = vi
      .fn()
      .mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
        expect(method).toBe("cron.add");
        const response = await addOverGateway(cron, params);
        if (!response.ok) {
          throw new GatewayClientRequestError(response.error ?? {});
        }
        return response.payload;
      });
    const tool = createCronTool(undefined, { callGatewayTool });

    await tool.execute("add-first", { action: "add", job: reminder("first") });

    await expect(
      tool.execute("add-second", { action: "add", job: reminder("second") }),
    ).rejects.toMatchObject({
      gatewayCode: "INVALID_REQUEST",
      message: expect.stringContaining(LIMIT_MESSAGE),
    });
    expect(callGatewayTool).toHaveBeenCalledTimes(2);
  });
});
