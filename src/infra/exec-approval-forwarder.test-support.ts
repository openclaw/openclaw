// Shared fixtures for exec approval forwarder tests.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createApprovalNativeRouteCoordinator,
  type ApprovalNativeRouteCoordinator,
} from "./approval-native-route-coordinator.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

export const baseRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

const activeForwarders: Array<ReturnType<typeof createExecApprovalForwarder>> = [];
const activeRouteCoordinators: ApprovalNativeRouteCoordinator[] = [];

export type NativeRouteFixture = {
  channel: string;
  accountId?: string;
  handledKinds?: ChannelApprovalKind[];
};

function startNativeApprovalRoute(
  params: NativeRouteFixture & { coordinator: ApprovalNativeRouteCoordinator },
) {
  const reporter = params.coordinator.createReporter({
    handledKinds: new Set(params.handledKinds ?? ["exec", "plugin", "system-agent"]),
    channel: params.channel,
    accountId: params.accountId,
    requestGateway: async () => {
      throw new Error("route notices are not expected");
    },
    shouldHandle: () => true,
    classifyRoute: () => "unbound",
  });
  reporter.start();
  return reporter;
}

export async function stopForwarderFixtures(): Promise<void> {
  await Promise.all(activeForwarders.splice(0).map((forwarder) => forwarder.stop()));
  for (const coordinator of activeRouteCoordinators.splice(0)) {
    coordinator.close();
  }
}

export const emptyRegistry = createTestRegistry([]);

export async function flushPendingDelivery(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function isDiscordExecApprovalClientEnabledForTest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const accountId = params.accountId?.trim();
  const rootConfig = params.cfg.channels?.discord?.execApprovals;
  const accountConfig =
    accountId && accountId !== "default"
      ? (
          params.cfg.channels?.discordAccounts?.[accountId] as
            | { execApprovals?: { enabled?: boolean; approvers?: unknown[] } }
            | undefined
        )?.execApprovals
      : undefined;
  const config = accountConfig ?? rootConfig;
  return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}

function isTelegramExecApprovalClientEnabledForTest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const accountId = params.accountId?.trim();
  const rootConfig = params.cfg.channels?.telegram?.execApprovals;
  const accountConfig =
    accountId && accountId !== "default"
      ? (
          params.cfg.channels?.telegramAccounts?.[accountId] as
            | { execApprovals?: { enabled?: boolean; approvers?: unknown[] } }
            | undefined
        )?.execApprovals
      : undefined;
  const config = accountConfig ?? rootConfig;
  return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}

function shouldSuppressTelegramExecApprovalForwardingFallbackForTest(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: { request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
}): boolean {
  if (
    params.target.channel !== "telegram" ||
    params.request.request.turnSourceChannel !== "telegram"
  ) {
    return false;
  }
  const accountId =
    params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
  return isTelegramExecApprovalClientEnabledForTest({ cfg: params.cfg, accountId });
}

function buildTelegramExecApprovalPendingPayloadForTest(params: {
  request: { id: string };
}): ReplyPayload {
  return {
    text: `Telegram exec approval ${params.request.id}`,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: `/approve ${params.request.id} allow-once`,
              style: "success",
            },
            {
              label: "Allow Always",
              value: `/approve ${params.request.id} allow-always`,
              style: "primary",
            },
            {
              label: "Deny",
              value: `/approve ${params.request.id} deny`,
              style: "danger",
            },
          ],
        },
      ],
    },
    channelData: {
      execApproval: {
        approvalId: params.request.id,
      },
      telegram: {
        buttons: [
          [
            { text: "Allow Once", callback_data: `/approve ${params.request.id} allow-once` },
            { text: "Allow Always", callback_data: `/approve ${params.request.id} allow-always` },
          ],
          [{ text: "Deny", callback_data: `/approve ${params.request.id} deny` }],
        ],
      },
    },
  };
}

export const telegramApprovalPlugin: Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "approvalCapability"
> = {
  ...createChannelTestPluginBase({ id: "telegram" }),
  approvalCapability: {
    delivery: {
      shouldSuppressForwardingFallback: (params: {
        cfg: OpenClawConfig;
        target: { channel: string; accountId?: string | null };
        request: {
          request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null };
        };
      }) => shouldSuppressTelegramExecApprovalForwardingFallbackForTest(params),
    },
    render: {
      exec: {
        buildPendingPayload: ({ request }: { request: { id: string } }) =>
          buildTelegramExecApprovalPendingPayloadForTest({ request }),
      },
    },
  },
};
export const discordApprovalPlugin: Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "approvalCapability"
> = {
  ...createChannelTestPluginBase({ id: "discord" }),
  approvalCapability: {
    delivery: {
      shouldSuppressForwardingFallback: ({
        cfg,
        target,
      }: {
        cfg: OpenClawConfig;
        target: { channel: string; accountId?: string | null };
      }) =>
        target.channel === "discord" &&
        isDiscordExecApprovalClientEnabledForTest({ cfg, accountId: target.accountId }),
    },
  },
};
export const defaultRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: telegramApprovalPlugin,
    source: "test",
  },
  {
    pluginId: "discord",
    plugin: discordApprovalPlugin,
    source: "test",
  },
]);

export function getFirstDeliveryText(deliver: ReturnType<typeof vi.fn>): string {
  const firstCall = requireFirstCallArg(deliver, "delivery params") as {
    payloads?: Array<{ text?: string }>;
  };
  return firstCall.payloads?.[0]?.text ?? "";
}

export const requireRecord = createRequireRecord("object", "expected-label-object");

export function requireFirstCallArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const firstCall = mock.mock.calls[0];
  if (!firstCall) {
    throw new Error(`expected ${label} call`);
  }
  return requireRecord(firstCall[0], label);
}

export function requireFirstPayload(deliver: ReturnType<typeof vi.fn>): ReplyPayload {
  const delivery = requireFirstCallArg(deliver, "delivery params") as {
    payloads?: ReplyPayload[];
  };
  const payload = delivery.payloads?.[0];
  if (!payload) {
    throw new Error("expected first delivery payload");
  }
  return payload;
}

export function makeTargetsCfg(targets: Array<{ channel: string; to: string }>): OpenClawConfig {
  return {
    approvals: {
      exec: {
        enabled: true,
        mode: "targets",
        targets,
      },
    },
  } as OpenClawConfig;
}

export const TARGETS_CFG = makeTargetsCfg([{ channel: "slack", to: "U123" }]);

export function createForwarder(params: {
  cfg: OpenClawConfig;
  deliver?: ReturnType<typeof vi.fn>;
  resolveSessionTarget?: NonNullable<
    NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["resolveSessionTarget"]
  >;
  /** Native approval handlers running in the owning Gateway when the request arrives. */
  nativeRoutes?: NativeRouteFixture[];
}) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const coordinator = createApprovalNativeRouteCoordinator();
  activeRouteCoordinators.push(coordinator);
  const nativeRoutes = (params.nativeRoutes ?? []).map((route) =>
    startNativeApprovalRoute({ coordinator, ...route }),
  );
  const deps: NonNullable<Parameters<typeof createExecApprovalForwarder>[0]> = {
    getConfig: () => params.cfg,
    deliver: deliver as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]
    >,
    nowMs: () => 1000,
    getNativeApprovalRouteCoordinator: () => coordinator,
  };
  if (params.resolveSessionTarget !== undefined) {
    deps.resolveSessionTarget = params.resolveSessionTarget;
  }
  const forwarder = createExecApprovalForwarder(deps);
  activeForwarders.push(forwarder);
  return { deliver, forwarder, nativeRoutes };
}
