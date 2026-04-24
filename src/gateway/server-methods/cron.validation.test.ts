import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";

const loadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig));
const resolveCronDeliveryPreviews = vi.hoisted(() =>
  vi.fn(async () => ({ "cron-1": { label: "preview", detail: "preview detail" } })),
);

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryPreviews,
}));

import { cronHandlers } from "./cron.js";

function createCronContext(currentJob?: CronJob) {
  return {
    cron: {
      add: vi.fn(async () => ({ id: "cron-1" })),
      update: vi.fn(async () => ({ id: "cron-1" })),
      listPage: vi.fn(async () => ({
        jobs: [currentJob ?? createCronJob()],
        total: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
        nextOffset: null,
      })),
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn(() => currentJob),
    },
    logGateway: {
      info: vi.fn(),
    },
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

async function invokeCronList(params: Record<string, unknown> = {}, currentJob?: CronJob) {
  const context = createCronContext(currentJob);
  const respond = vi.fn();
  await cronHandlers["cron.list"]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
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
    loadConfig.mockReset().mockReturnValue({} as OpenClawConfig);
    resolveCronDeliveryPreviews.mockClear().mockResolvedValue({
      "cron-1": { label: "preview", detail: "preview detail" },
    });
    delete process.env.OPENCLAW_CRON_LIST_DELIVERY_PREVIEWS;
  });

  it("rejects ambiguous announce delivery on add when multiple channels are configured", async () => {
    loadConfig.mockReturnValue({
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
    loadConfig.mockReturnValue({
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

  it("returns cron.list without delivery previews by default", async () => {
    const job = createCronJob();
    const { respond } = await invokeCronList({ includeDisabled: true }, job);

    expect(resolveCronDeliveryPreviews).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        jobs: [job],
        deliveryPreviews: {},
        deliveryPreviewsEnabled: false,
      }),
      undefined,
    );
  });

  it("allows opt-in delivery previews for cron.list via env flag", async () => {
    process.env.OPENCLAW_CRON_LIST_DELIVERY_PREVIEWS = "1";
    const job = createCronJob();
    const { respond } = await invokeCronList({ includeDisabled: true }, job);

    expect(resolveCronDeliveryPreviews).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        jobs: [job],
        deliveryPreviews: {
          "cron-1": { label: "preview", detail: "preview detail" },
        },
        deliveryPreviewsEnabled: true,
      }),
      undefined,
    );
  });

  it("rejects target ids mistakenly supplied as delivery.channel providers", async () => {
    loadConfig.mockReturnValue({
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
