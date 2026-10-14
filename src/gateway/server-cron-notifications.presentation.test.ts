import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (_request: GuardedFetchOptions) => ({
    response: new Response(null, { status: 204 }),
    finalUrl: "https://example.invalid/cron",
    release: vi.fn(async () => {}),
  })),
  sendCronAnnouncePayloadStrict: vi.fn(),
  resolveDeliveryTarget: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(
    async (_cfg, _agentId, target) => ({
      ok: true,
      channel: target.channel ?? "telegram",
      to: target.to ?? "channel:ops",
      accountId: target.accountId,
      threadId: target.threadId,
      mode: "explicit",
    }),
  ),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

vi.mock("../cron/isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof deliveryTarget>()),
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

import { sendGatewayCronFailureAlert as sendGatewayCronFailureAlertBase } from "./server-cron-notifications.js";

const sendGatewayCronFailureAlert = (
  params: Omit<
    Parameters<typeof sendGatewayCronFailureAlertBase>[0],
    "onDeliverySettled" | "routing"
  >,
) =>
  sendGatewayCronFailureAlertBase({
    ...params,
    routing: { defaultAgentId: "main" },
    onDeliverySettled: async () => {},
  });

describe("sendGatewayCronFailureAlert presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue({
      status: "sent",
      results: [],
      receipt: {
        primaryPlatformMessageId: undefined,
        platformMessageIds: [],
        parts: [],
        sentAt: 0,
      },
    });
  });

  it("keeps failure webhook messages stable and adds structured runAtMs", async () => {
    const runAtMs = Date.parse("2026-01-15T15:30:00.000Z");
    const job = makeCronJob({
      delivery: {
        mode: "announce",
        completionDestination: { mode: "webhook", to: "https://example.invalid/cron" },
      },
    });
    const webhookSsrfPolicy = { allowedHostnames: ["127.0.0.1"] };

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
      job,
      payload: { text: "cron failed" },
      runAtMs,
      channel: "last",
      mode: "webhook",
      to: "https://example.invalid/cron",
      ssrfPolicy: webhookSsrfPolicy,
    });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ policy: webhookSsrfPolicy }),
    );
    const body = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init?.body;
    if (typeof body !== "string") {
      throw new Error("expected webhook request body");
    }
    expect(JSON.parse(body)).toEqual({
      jobId: job.id,
      jobName: job.name,
      message: "cron failed",
      runAtMs,
    });
  });

  it.each([
    {
      name: "without a public origin",
      gateway: undefined,
      expectedText: "cron failed\nRun started: 2026-01-15 10:30 EST",
    },
    {
      name: "with a public origin",
      gateway: {
        publicOrigin: "https://gateway.example",
        controlUi: { basePath: "/control" },
      },
      expectedText:
        "cron failed\nRun started: 2026-01-15 10:30 EST\nInspect: https://gateway.example/control/automations?job=job-1&run=cron%3Ajob-1%3A1768491000000",
    },
  ])(
    "composes failure alert details $name without dropping presentation",
    async ({ gateway, expectedText }) => {
      const job = makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "channel:ops",
        },
      });

      await sendGatewayCronFailureAlert({
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({
          agentId: "main",
          cfg: { agents: { defaults: { userTimezone: "America/New_York" } }, gateway },
        }),
        job,
        payload: {
          text: "cron failed",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Log in to Codex",
                    action: { type: "command", command: "/login codex" },
                  },
                ],
              },
            ],
          },
        },
        runAtMs: Date.parse("2026-01-15T15:30:00.000Z"),
        channel: "telegram",
        to: "channel:ops",
        mode: "announce",
      });

      expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            text: expectedText,
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Log in to Codex",
                      action: { type: "command", command: "/login codex" },
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    },
  );
});
