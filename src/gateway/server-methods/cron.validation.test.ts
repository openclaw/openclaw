import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig,
  };
});

import { buildCronListDiagnosticEvent, cronHandlers } from "./cron.js";

const OPENCLAW_CRON_LIST_DIAGNOSTIC_DEBUG = "OPENCLAW_CRON_LIST_DIAGNOSTIC_DEBUG";

function createCronContext(currentJob?: CronJob) {
  return {
    cron: {
      add: vi.fn(async () => ({ id: "cron-1" })),
      update: vi.fn(async () => ({ id: "cron-1" })),
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn(() => currentJob),
    },
    logGateway: {
      info: vi.fn(),
    },
    getRuntimeConfig: () => getRuntimeConfig(),
  };
}

async function invokeCronAdd(params: Record<string, unknown>) {
  const context = createCronContext();
  const respond = vi.fn();
  await cronHandlers["cron.add"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
}

async function invokeCronUpdate(params: Record<string, unknown>, currentJob: CronJob) {
  const context = createCronContext(currentJob);
  const respond = vi.fn();
  await cronHandlers["cron.update"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
}

async function invokeCronList(params: Record<string, unknown>, jobs: CronJob[]) {
  const logLines: string[] = [];
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await cronHandlers["cron.list"]({
    req: {} as never,
    params: params as never,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      result = { ok, payload, error };
    },
    context: {
      cron: {
        listPage: async () => ({
          jobs,
          total: jobs.length,
          offset: 0,
          limit: jobs.length || 50,
          hasMore: false,
          nextOffset: null,
        }),
        getDefaultAgentId: () => "main",
      },
      logGateway: {
        info: (message: string) => {
          logLines.push(message);
        },
      },
      getRuntimeConfig: () =>
        ({
          session: { mainKey: "SESSION_CONTENT_SHOULD_NOT_APPEAR" },
          plugins: {
            entries: {
              telegram: {
                enabled: true,
                label: "CONFIG_CONTENT_SHOULD_NOT_APPEAR",
              },
            },
          },
        }) as OpenClawConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  if (!result) {
    throw new Error("cron.list did not respond");
  }
  return { result, logLines };
}

function createCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron-1",
    name: "cron job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  };
}

describe("cron method validation", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({} as OpenClawConfig);
    delete process.env[OPENCLAW_CRON_LIST_DIAGNOSTIC_DEBUG];
  });

  afterEach(() => {
    delete process.env[OPENCLAW_CRON_LIST_DIAGNOSTIC_DEBUG];
  });

  it("builds cron.list diagnostics from an allow-listed redacted shape", () => {
    const err = new Error("PROMPT_CONTENT_SHOULD_NOT_APPEAR");
    err.name = "CronListTimeout";
    (err as Error & { code: string }).code = "E_CRON_TIMEOUT";

    const event = buildCronListDiagnosticEvent({
      stage: "delivery_preview_error",
      elapsedMs: 12.8,
      includeDisabled: true,
      limit: 25,
      jobCount: 3,
      deliveryPreviewCount: 2,
      ok: false,
      error: err,
    });

    expect(event).toEqual({
      stage: "delivery_preview_error",
      elapsedMs: 12,
      includeDisabled: true,
      limit: 25,
      jobCount: 3,
      deliveryPreviewCount: 2,
      ok: false,
      errorName: "CronListTimeout",
      errorCode: "E_CRON_TIMEOUT",
    });
    expect(Object.keys(event).toSorted()).toEqual(
      [
        "deliveryPreviewCount",
        "elapsedMs",
        "errorCode",
        "errorName",
        "includeDisabled",
        "jobCount",
        "limit",
        "ok",
        "stage",
      ].toSorted(),
    );
    expect(JSON.stringify(event)).not.toContain("PROMPT_CONTENT_SHOULD_NOT_APPEAR");
  });

  it("does not emit cron.list diagnostics unless explicitly enabled", async () => {
    const { result, logLines } = await invokeCronList({ includeDisabled: true, limit: 1 }, [
      createCronJob(),
    ]);

    expect(result.ok).toBe(true);
    expect(logLines).toEqual([]);
  });

  it("emits redacted cron.list stage timing without changing the response payload", async () => {
    process.env[OPENCLAW_CRON_LIST_DIAGNOSTIC_DEBUG] = "1";
    const job = createCronJob({
      id: "cron-sensitive",
      name: "diagnostic list job",
      description: "JOB_COMMAND_SHOULD_NOT_APPEAR",
      payload: {
        kind: "agentTurn",
        message: "PROMPT_CONTENT_SHOULD_NOT_APPEAR",
      },
      delivery: {
        mode: "webhook",
        to: "WEBHOOK_DESTINATION_SHOULD_NOT_APPEAR",
      },
    });

    const { result, logLines } = await invokeCronList({ includeDisabled: true, limit: 1 }, [job]);

    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      jobs: [job],
      total: 1,
      offset: 0,
      limit: 1,
      hasMore: false,
      nextOffset: null,
      deliveryPreviews: {
        "cron-sensitive": {
          label: "webhook:WEBHOOK_DESTINATION_SHOULD_NOT_APPEAR",
          detail: "webhook",
        },
      },
    });
    const expectedStages = [
      "handler_entered",
      "params_validated",
      "list_page_start",
      "list_page_end",
      "config_reload_start",
      "config_reload_end",
      "delivery_preview_start",
      "delivery_preview_end",
      "response_payload_assembled",
      "response_send_start",
      "response_send_end",
    ];
    for (const stage of expectedStages) {
      expect(logLines.some((line) => line.includes(`stage=${stage}`))).toBe(true);
    }
    for (const line of logLines) {
      expect(line).toMatch(/^cron\.list diagnostic /);
      expect(line).toMatch(/elapsedMs=\d+/);
      expect(line).not.toContain("JOB_COMMAND_SHOULD_NOT_APPEAR");
      expect(line).not.toContain("PROMPT_CONTENT_SHOULD_NOT_APPEAR");
      expect(line).not.toContain("WEBHOOK_DESTINATION_SHOULD_NOT_APPEAR");
      expect(line).not.toContain("CONFIG_CONTENT_SHOULD_NOT_APPEAR");
      expect(line).not.toContain("SESSION_CONTENT_SHOULD_NOT_APPEAR");
      expect(line).not.toContain("telegram");
    }
  });

  it("accepts threadId on announce delivery add params", async () => {
    getRuntimeConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd({
      name: "topic announce add",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: 123,
      },
    });

    expect(context.cron.add).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: 123,
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
  });

  it("accepts threadId on announce delivery update params", async () => {
    getRuntimeConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "-1001234567890",
            threadId: "456",
          },
        },
      },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
      }),
    );

    expect(context.cron.update).toHaveBeenCalledWith(
      "cron-1",
      expect.objectContaining({
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: "456",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
  });

  it("rejects ambiguous announce delivery on add when multiple channels are configured", async () => {
    getRuntimeConfig.mockReturnValue({
      session: {
        mainKey: "main",
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
          slack: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd({
      name: "ambiguous announce add",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "announce" },
    });

    expect(context.cron.add).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("delivery.channel is required"),
      }),
    );
  });

  it("rejects ambiguous announce delivery on update when multiple channels are configured", async () => {
    getRuntimeConfig.mockReturnValue({
      session: {
        mainKey: "main",
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
          slack: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: { mode: "announce" },
        },
      },
      createCronJob(),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("delivery.channel is required"),
      }),
    );
  });

  it("rejects target ids mistakenly supplied as delivery.channel providers", async () => {
    getRuntimeConfig.mockReturnValue({
      session: {
        mainKey: "main",
      },
      channels: {
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
      },
      plugins: {
        entries: {
          slack: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd({
      name: "invalid delivery provider",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "C0AT2Q238MQ",
        to: "C0AT2Q238MQ",
      },
    });

    expect(context.cron.add).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("delivery.channel must be one of: slack"),
      }),
    );
  });
});
