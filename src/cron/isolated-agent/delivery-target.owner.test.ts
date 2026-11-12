import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "../../infra/outbound/targets.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import { resolveCronSourceDeliveryPlan } from "./source-delivery-plan.js";

const snapshot = captureActivePluginRegistrySnapshot();
const cfg: OpenClawConfig = {
  agents: { defaults: { heartbeat: { target: "none", directPolicy: "block" } } },
  channels: { alpha: { enabled: true }, beta: { enabled: true } },
  commands: { ownerAllowFrom: ["alpha:user:alice", "beta:user:bob"] },
};
const sessionContext = {
  mainSessionKey: "agent:main:main",
  usedSharedMainFallback: true,
  main: {
    sessionId: "group-session",
    updatedAt: 1,
    chatType: "group" as const,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "alpha", to: "group:public", accountId: "default" },
    }),
  },
};

beforeEach(() => {
  setActivePluginRegistry(
    createTargetsTestRegistry(
      ["alpha", "beta"].map((id) => {
        const plugin = createGenericTargetTestPlugin(id);
        plugin.config.listAccountIds = () => ["default", "secondary"];
        return plugin;
      }),
    ),
  );
});
afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));

const resolve = (target: Parameters<typeof resolveDeliveryTarget>[2], config = cfg) =>
  resolveDeliveryTarget(config, "main", target, { sessionContext });
const sourcePlan = (
  resolvedDelivery: Awaited<ReturnType<typeof resolveDeliveryTarget>>,
  target: Parameters<typeof resolveDeliveryTarget>[2] = { target: "owner" },
) =>
  resolveCronSourceDeliveryPlan({
    deliveryPlan: { ...target, mode: "announce", requested: true, source: "delivery" },
    resolvedDelivery,
  });

const unavailable = { ok: false, channel: "none", mode: "explicit" };
const suppressed = { ok: false, deliverySuppressionReason: "channel_transform" };
it.each([
  [
    "owner account",
    { target: "owner", channel: "beta", accountId: "secondary" },
    cfg,
    { ok: true, channel: "beta", to: "user:bob", accountId: "secondary", mode: "explicit" },
  ],
  ["missing owner", { target: "owner" }, { ...cfg, commands: {} }, unavailable],
  ["unknown account", { target: "owner", accountId: "missing" }, cfg, unavailable],
  ["blocked owner", { target: "owner", channel: "beta", directPolicy: "block" }, cfg, suppressed],
  ["blocked explicit", { channel: "beta", to: "user:bob", directPolicy: "block" }, cfg, suppressed],
] as const)(
  "resolves %s without inheriting the remembered group",
  async (_name, target, config, expected) => {
    const result = await resolve(target, config);
    expect(result).toMatchObject(expected);
    if (!expected.ok) {
      expect(sourcePlan(result, target).messageTool.enabled).toBe(false);
      if (expected === unavailable) {
        expect(result.to).toBeUndefined();
        expect(sourcePlan(result, target).fallback.skipWhenMessageToolSentToTarget).toBe(false);
      }
    }
  },
);
