import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { resolveFailureAlert } from "../cron/service/failure-alerts.js";
import { cronNotificationJob } from "../cron/service/notification-intents.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "../infra/outbound/targets.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

const { sendCronAnnouncePayloadStrictMock, sessionEntries } = vi.hoisted(() => ({
  sendCronAnnouncePayloadStrictMock: vi.fn(),
  sessionEntries: new Map<string, SessionEntry>(),
}));
const onDeliverySettled = vi.fn(async () => {});

vi.mock("../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: vi.fn(async () => ({
    deliveryContext: undefined,
    threadId: undefined,
  })),
  extractDeliveryInfoBatch: vi.fn(async (requests: readonly unknown[]) =>
    requests.map(() => ({ deliveryContext: undefined, threadId: undefined })),
  ),
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntriesFromStoreInWorker: vi.fn(
    async ({ sessionKeys }: { sessionKeys: string[] }) => ({
      entries: sessionKeys.flatMap((sessionKey) => {
        const entry = sessionEntries.get(sessionKey);
        return entry ? [{ sessionKey, entry }] : [];
      }),
    }),
  ),
}));

vi.mock("../infra/outbound/channel-selection.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/channel-selection.runtime.js")>()),
  resolveMessageChannelSelection: vi.fn(),
}));

vi.mock("../cron/delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/delivery.js")>()),
  sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
}));

const mockedModuleIds = [
  "../config/sessions/delivery-info.js",
  "../config/sessions/session-entry-read-runtime.js",
  "../infra/outbound/channel-selection.runtime.js",
  "../cron/delivery.js",
];

import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.runtime.js";
import { sendGatewayCronFailureAlert } from "./server-cron-notifications.js";

const MAIN = "agent:main:main";
const CFG = {
  bindings: [],
  session: { store: "/tmp/test-store.json" },
  channels: { telegram: { enabled: true } },
  commands: { ownerAllowFrom: ["telegram:user:111"] },
} as OpenClawConfig;

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

type LastRoute = { to: string; chatType: "direct" | "group" };

function ownerAlertFixture(lastRoute?: LastRoute, directPolicy?: "block") {
  sessionEntries.set(MAIN, {
    sessionId: "session",
    updatedAt: 1_000,
    ...(lastRoute
      ? {
          chatType: lastRoute.chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: lastRoute.to },
          }),
        }
      : {}),
  } as SessionEntry);
  const job = makeCronJob({
    agentId: "main",
    sessionTarget: `session:${MAIN}`,
    sessionKey: MAIN,
    delivery: { mode: "announce", target: "owner", ...(directPolicy ? { directPolicy } : {}) },
  });
  const route = resolveFailureAlert({ deps: { cronConfig: undefined } }, job);
  if (!route) {
    throw new Error("Expected an owner failure-alert route");
  }
  return sendGatewayCronFailureAlert({
    job: cronNotificationJob(job),
    routing: {},
    payload: { text: "Synthetic automation failure" },
    runAtMs: Date.parse("2026-10-31T00:00:00Z"),
    ...route,
    onDeliverySettled,
    deps: {} as CliDeps,
    logger: { warn: vi.fn() },
    resolveCronAgent: () => ({ agentId: "main", cfg: CFG }),
  });
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  const plugin = createGenericTargetTestPlugin("telegram", "Telegram");
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
  resetGatewayWorkAdmission();
  setActiveDegradedSecretOwners([]);
  sessionEntries.clear();
  vi.clearAllMocks();
  vi.mocked(resolveMessageChannelSelection).mockResolvedValue({
    channel: "telegram",
    plugin,
  });
  sendCronAnnouncePayloadStrictMock.mockResolvedValue({ status: "sent", payloads: [] });
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  setActiveDegradedSecretOwners([]);
  sessionEntries.clear();
});

it.each<[string, LastRoute | undefined]>([
  ["without a last route", undefined],
  ["instead of direct last route 999", { to: "999", chatType: "direct" }],
  ["instead of group last route -100777", { to: "-100777", chatType: "group" }],
])("delivers owner alert %s to owner 111", async (_name, lastRoute) => {
  await expect(ownerAlertFixture(lastRoute)).resolves.toBeUndefined();
  expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
  const target = sendCronAnnouncePayloadStrictMock.mock.calls[0]?.[0]?.target as
    | { channel?: string; to?: string }
    | undefined;
  expect(target?.channel).toBe("telegram");
  expect(String(target?.to).replace(/^(?:telegram:)?(?:user:)?/i, "")).toBe("111");
  expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
    delivered: true,
    status: "delivered",
  });
});

it("rejects an owner alert when direct-message delivery is blocked", async () => {
  const delivery = ownerAlertFixture({ to: "999", chatType: "direct" }, "block");
  await expect(delivery).rejects.toThrow("Owner delivery unavailable (dm-blocked)");
  expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
});
