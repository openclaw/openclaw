import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cronHandlers } from "./cron.js";
import { registerCronListVisibilityTests } from "./cron.validation.list-visibility.test-support.js";
import {
  createCronJob,
  createCronTestContext,
  callerClient,
  setCronValidationTestRegistry,
} from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
  loadGatewaySessionEntry: vi.fn((sessionKey: string) => ({
    canonicalKey: sessionKey,
    entry: undefined,
  })),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, getRuntimeConfig: mocks.getRuntimeConfig };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadGatewaySessionEntry,
    loadGatewaySessionEntryReadOnly: mocks.loadGatewaySessionEntry,
  };
});

const createCronContext = (
  jobs?: ReturnType<typeof createCronJob> | ReturnType<typeof createCronJob>[],
) => createCronTestContext(jobs, mocks.getRuntimeConfig);

async function invokeCron(
  method: "cron.list",
  params: Record<string, unknown>,
  options?: { context?: ReturnType<typeof createCronContext>; client?: GatewayClient },
) {
  const context = options?.context ?? createCronContext();
  const respond = vi.fn();
  await expectDefined(
    cronHandlers[method],
    "cronHandlers[method] test invariant",
  )({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: options?.client ?? null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
}

function setRuntimeConfig(config: OpenClawConfig): void {
  mocks.getRuntimeConfig.mockReturnValue(config);
}

setCronValidationTestRegistry();
registerCronListVisibilityTests({
  createCronContext,
  invokeCron,
  setRuntimeConfig,
  loadGatewaySessionEntry: mocks.loadGatewaySessionEntry,
});

it.each([{ compact: true }, { includeDeliveryPreviews: false }])(
  "does not publish a current-job page after its claim expires: %j",
  async (params) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const job = createCronJob({
      id: "scheduled-current-job",
      agentId: "ops",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const context = createCronContext(job);
    const readJob = context.cron.getJob.getMockImplementation();
    context.cron.getJob.mockImplementation((id) => {
      const result = readJob?.(id);
      // Expire after the page's first authority check, during metadata preparation.
      queueMicrotask(() => {
        now = 2_000;
      });
      return result;
    });
    const respond = vi.fn();
    try {
      await expect(
        expectDefined(
          cronHandlers["cron.list"],
          "cron.list handler",
        )({
          req: {} as never,
          params: { ...params, includeVisibility: true } as never,
          respond,
          context: context as never,
          client: callerClient("ops", undefined, undefined, job.id, 1_500),
          isWebchatConnect: () => false,
        }),
      ).rejects.toThrow("Cron list visibility changed; refresh the page");
      expect(respond).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);
