import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../../cron/types.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "Daily Check",
    enabled: overrides.enabled ?? true,
    createdAtMs: overrides.createdAtMs ?? 1,
    updatedAtMs: overrides.updatedAtMs ?? 1,
    schedule: overrides.schedule ?? { kind: "every", everyMs: 3_600_000 },
    sessionTarget: overrides.sessionTarget ?? "main",
    wakeMode: overrides.wakeMode ?? "now",
    payload: overrides.payload ?? { kind: "systemEvent", text: "Check inbox" },
    state: overrides.state ?? { nextRunAtMs: Date.parse("2026-03-03T13:30:00.000Z") },
  };
}

function buildParams(commandBody: string, ctxOverrides?: Partial<MsgContext>) {
  const cfg = {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
  return buildCommandTestParams(commandBody, cfg, ctxOverrides);
}

describe("/crons command", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("lists active cron jobs", async () => {
    const fast = makeCronJob({ id: "fast", name: "Morning Prep" });
    const slow = makeCronJob({ id: "slow", name: "Nightly Wrap" });
    callGatewayMock.mockResolvedValueOnce({
      jobs: [fast, slow],
      hasMore: false,
      nextOffset: null,
    });

    const result = await handleCommands(buildParams("/crons"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Active cron jobs (2):");
    expect(result.reply?.text).toContain("1. Morning Prep");
    expect(result.reply?.text).toContain("Summary:");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({
          enabled: "enabled",
          sortBy: "nextRunAtMs",
          sortDir: "asc",
          limit: 200,
          offset: 0,
        }),
      }),
    );
  });

  it("lists all cron jobs (including inactive)", async () => {
    const active = makeCronJob({ id: "a", name: "Active", enabled: true });
    const inactive = makeCronJob({ id: "b", name: "Inactive", enabled: false, state: {} });
    callGatewayMock.mockResolvedValueOnce({
      jobs: [active, inactive],
      hasMore: false,
      nextOffset: null,
    });

    const result = await handleCommands(buildParams("/crons all"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Cron jobs (including inactive) (2):");
    expect(result.reply?.text).toContain("Inactive (inactive)");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({ enabled: "all" }),
      }),
    );
  });

  it("paginates cron list responses so /crons is uncapped", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        jobs: [makeCronJob({ id: "one", name: "First" })],
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        jobs: [makeCronJob({ id: "two", name: "Second" })],
        hasMore: false,
        nextOffset: null,
      });

    const result = await handleCommands(buildParams("/crons"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("1. First");
    expect(result.reply?.text).toContain("2. Second");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({ offset: 0 }),
      }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({ offset: 1 }),
      }),
    );
  });

  it("deletes all cron jobs", async () => {
    const jobs = [makeCronJob({ id: "a" }), makeCronJob({ id: "b" })];
    callGatewayMock
      .mockResolvedValueOnce({ jobs, hasMore: false, nextOffset: null })
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce({ removed: true });

    const result = await handleCommands(buildParams("/crons delete"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("✅ Deleted 2 cron jobs.");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({ enabled: "all" }),
      }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "cron.remove", params: { id: "a" } }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "cron.remove", params: { id: "b" } }),
    );
  });

  it("deletes inactive cron jobs only", async () => {
    const inactive = [
      makeCronJob({ id: "x", enabled: false }),
      makeCronJob({ id: "y", enabled: false }),
    ];
    callGatewayMock
      .mockResolvedValueOnce({ jobs: inactive, hasMore: false, nextOffset: null })
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce({ removed: true });

    const result = await handleCommands(buildParams("/crons delete-inactive"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("✅ Deleted 2 inactive cron jobs.");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({ enabled: "disabled" }),
      }),
    );
  });

  it("returns usage for unsupported args", async () => {
    const result = await handleCommands(buildParams("/crons nope"));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("Usage: /crons [all|delete|delete-inactive]");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("ignores unauthorized senders", async () => {
    const params = buildParams("/crons");
    params.command.isAuthorizedSender = false;

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("requires operator.admin for gateway clients", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/crons", cfg, {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.read"],
    });
    params.command = buildCommandContext({
      ctx: params.ctx,
      cfg,
      isGroup: false,
      triggerBodyNormalized: "/crons",
      commandAuthorized: true,
    });
    params.command.isAuthorizedSender = true;

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("requires operator.admin");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
