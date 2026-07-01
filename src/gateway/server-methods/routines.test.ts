import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { routinesHandlers } from "./routines.js";
import type { GatewayClient } from "./types.js";

function createCronJob(input: CronJobCreate, nowMs: number): CronJob {
  return {
    ...input,
    id: input.id ?? "cron-1",
    enabled: input.enabled ?? true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    state: {},
  };
}

function createRoutineContext() {
  const jobs = new Map<string, CronJob>();
  const cron = {
    list: vi.fn(async () => [...jobs.values()]),
    add: vi.fn(async (input: CronJobCreate) => {
      const job = createCronJob(input, Date.now());
      jobs.set(job.id, job);
      return job;
    }),
    update: vi.fn(async (id: string, patch: CronJobPatch) => {
      const current = jobs.get(id);
      if (!current) {
        throw new Error(`missing cron job: ${id}`);
      }
      const updated: CronJob = {
        ...current,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        state: { ...current.state, ...patch.state },
        updatedAtMs: Date.now(),
      };
      jobs.set(id, updated);
      return updated;
    }),
    readJob: vi.fn(async (id: string) => jobs.get(id)),
    getDefaultAgentId: vi.fn(() => "main"),
  };
  return {
    cron,
    cronStorePath: "/tmp/cron.sqlite",
    getRuntimeConfig: () => ({}),
    logGateway: { info: vi.fn() },
  };
}

function routineCreateParams(at: string) {
  return {
    id: "one-shot-briefing",
    name: "One-shot briefing",
    trigger: { kind: "schedule", schedule: { kind: "at", at } },
    target: { sessionTarget: "isolated", wakeMode: "now" },
    action: { kind: "agentTurn", message: "Review the queue." },
  };
}

function agentRuntimeClient(agentId: string): GatewayClient {
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId,
        sessionKey: `agent:${agentId}:main`,
      },
    },
  };
}

async function invokeRoutine(
  method: keyof typeof routinesHandlers,
  params: Record<string, unknown>,
  options: {
    context: ReturnType<typeof createRoutineContext>;
    client?: GatewayClient | null;
  },
) {
  const respond = vi.fn();
  await routinesHandlers[method]({
    req: {} as never,
    params,
    respond: respond as never,
    context: options.context as never,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function invokeRoutineCreate(context: ReturnType<typeof createRoutineContext>, at: string) {
  return await invokeRoutine("routines.create", routineCreateParams(at), {
    context,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routines gateway methods", () => {
  it("allows idempotent create replay after a one-shot schedule has passed", async () => {
    await withOpenClawTestState({ prefix: "gateway-routine-replay-" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const context = createRoutineContext();
      const at = new Date("2026-01-01T00:02:00Z").toISOString();

      const first = await invokeRoutineCreate(context, at);
      expect(first.mock.calls[0]?.[0]).toBe(true);
      expect(first.mock.calls[0]?.[1]).toMatchObject({ created: true, idempotent: false });

      vi.setSystemTime(new Date("2026-01-01T00:04:00Z"));
      const replay = await invokeRoutineCreate(context, at);

      expect(replay.mock.calls[0]?.[0]).toBe(true);
      expect(replay.mock.calls[0]?.[1]).toMatchObject({ created: false, idempotent: true });
      expect(context.cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects routine registry methods from agent-runtime callers", async () => {
    await withOpenClawTestState({ prefix: "gateway-routine-agent-scope-" }, async () => {
      const context = createRoutineContext();
      const client = agentRuntimeClient("agent-a");
      const at = new Date("2026-01-01T00:02:00Z").toISOString();
      const cases: Array<{
        method: keyof typeof routinesHandlers;
        params: Record<string, unknown>;
      }> = [
        { method: "routines.list", params: {} },
        { method: "routines.get", params: { id: "one-shot-briefing" } },
        {
          method: "routines.create",
          params: routineCreateParams(at),
        },
        { method: "routines.enable", params: { id: "one-shot-briefing" } },
        { method: "routines.disable", params: { id: "one-shot-briefing" } },
        { method: "routines.delete", params: { id: "one-shot-briefing" } },
      ];

      for (const testCase of cases) {
        const respond = await invokeRoutine(testCase.method, testCase.params, {
          context,
          client,
        });

        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(respond.mock.calls[0]?.[2]?.message).toContain(
          "routine registry methods are operator-scoped",
        );
      }
      expect(context.cron.add).not.toHaveBeenCalled();
    });
  });

  it("maps durable routine backend failures to unavailable", async () => {
    await withOpenClawTestState({ prefix: "gateway-routine-unavailable-" }, async () => {
      const context = createRoutineContext();
      context.cron.add.mockRejectedValueOnce(new Error("cron database busy"));
      const at = new Date(Date.now() + 60_000).toISOString();

      const respond = await invokeRoutineCreate(context, at);

      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]).toMatchObject({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("cron database busy"),
      });
    });
  });

  it("preserves invalid request for cron-backed routine specification errors", async () => {
    await withOpenClawTestState({ prefix: "gateway-routine-cron-invalid-" }, async () => {
      const context = createRoutineContext();
      context.cron.add.mockRejectedValueOnce(
        new Error('main cron jobs require payload.kind="systemEvent"'),
      );
      const at = new Date(Date.now() + 60_000).toISOString();

      const respond = await invokeRoutine(
        "routines.create",
        {
          ...routineCreateParams(at),
          target: { sessionTarget: "main", wakeMode: "now" },
        },
        { context },
      );

      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]).toMatchObject({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining('main cron jobs require payload.kind="systemEvent"'),
      });
    });
  });
});
