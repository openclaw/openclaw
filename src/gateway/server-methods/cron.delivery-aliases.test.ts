import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { loadCronRows } from "../../cron/store/row-codec.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  agentTurnCronParams,
  setCronValidationTestRegistry,
  telegramConfig,
} from "./cron.validation.test-support.js";

const cronLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-gateway-delivery-aliases-" });
const getRuntimeConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>(() => ({})));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, getRuntimeConfig };
});

vi.mock("../session-utils.js", () => {
  const loadSessionEntry = (sessionKey: string) => ({ canonicalKey: sessionKey, entry: undefined });
  return { loadSessionEntry, loadGatewaySessionEntryReadOnly: loadSessionEntry };
});

vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryPreview: async () => ({ label: "not requested", detail: "not requested" }),
  resolveCronDeliveryPreviews: async ({ jobs }: { jobs: Array<{ id: string }> }) =>
    Object.fromEntries(
      jobs.map((job) => [job.id, { label: "not requested", detail: "not requested" }]),
    ),
}));

import { cronHandlers } from "./cron.js";

beforeEach(() => {
  setCronValidationTestRegistry();
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("persists canonical delivery for published cron.add and cron.update request aliases", async () => {
  const { storePath } = await makeStorePath();
  getRuntimeConfig.mockReturnValue(telegramConfig());
  const scheduler = createTestGatewayScheduler();
  const cron = new CronService({
    scheduler,
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: cronLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  const context = createDirectChatContext({ cron, cronStorePath: storePath, getRuntimeConfig });
  const readRow = () =>
    expectDefined(
      loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath))[0],
      "persisted cron request",
    );
  const createDelivery = Object.freeze({
    mode: "deliver",
    channel: "telegram",
    to: "telegram:123",
  });
  const params = agentTurnCronParams({ enabled: false, delivery: createDelivery });
  const respond = vi.fn();
  try {
    await expectDefined(
      cronHandlers["cron.add"],
      "cron.add handler",
    )({
      req: { type: "req", id: "delivery-alias-add", method: "cron.add", params },
      params,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        delivery: { mode: "announce", channel: "telegram", to: "telegram:123" },
      }),
      undefined,
    );
    const created = readRow();
    expect(JSON.parse(created.job_json).delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:123",
    });
    expect(createDelivery.mode).toBe("deliver");
    await cron.update(created.job_id, { delivery: { mode: "none" } });
    expect(JSON.parse(readRow().job_json).delivery.mode).toBe("none");
    const updateDelivery = Object.freeze({ mode: " DeLiVeR ", to: "telegram:456" });
    const updateParams = { id: created.job_id, patch: { delivery: updateDelivery } };
    await expectDefined(
      cronHandlers["cron.update"],
      "cron.update handler",
    )({
      req: {
        type: "req",
        id: "delivery-alias-update",
        method: "cron.update",
        params: updateParams,
      },
      params: updateParams,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        id: created.job_id,
        delivery: { mode: "announce", channel: "telegram", to: "telegram:456" },
      }),
      undefined,
    );
    expect(JSON.parse(readRow().job_json).delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:456",
    });
    expect(updateDelivery.mode).toBe(" DeLiVeR ");
  } finally {
    cron.stop();
    await scheduler.stop();
  }
});
