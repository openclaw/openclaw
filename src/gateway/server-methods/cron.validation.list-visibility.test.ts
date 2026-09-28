import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cronHandlers } from "./cron.js";
import { registerCronListVisibilityTests } from "./cron.validation.list-visibility.test-support.js";
import {
  createCronJob,
  createCronTestContext,
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

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: mocks.loadGatewaySessionEntry,
  loadGatewaySessionEntryReadOnly: mocks.loadGatewaySessionEntry,
}));

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
