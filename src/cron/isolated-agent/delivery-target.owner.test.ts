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

it("resolves the requested owner channel/account without inheriting heartbeat policy or a group", async () => {
  expect(await resolve({ target: "owner", channel: "beta", accountId: "secondary" })).toMatchObject(
    {
      ok: true,
      channel: "beta",
      to: "user:bob",
      accountId: "secondary",
      mode: "explicit",
    },
  );
});

it.each([
  { name: "missing owner", config: { ...cfg, commands: {} }, accountId: undefined },
  { name: "unknown owner account", config: cfg, accountId: "missing" },
])("does not route $name to a remembered group or enable the message tool", async (row) => {
  const result = await resolve({ target: "owner", accountId: row.accountId }, row.config);
  expect(result).toMatchObject({ ok: false, channel: "none", mode: "explicit" });
  expect(result.to).toBeUndefined();
  expect(sourcePlan(result)).toMatchObject({
    messageTool: { enabled: false },
    fallback: { skipWhenMessageToolSentToTarget: false },
  });
});

it.each([
  { name: "owner", target: "owner" as const, channel: "beta" },
  { name: "explicit", channel: "beta", to: "user:bob" },
])("reports intentional DM suppression for $name delivery", async ({ name: _name, ...target }) => {
  const result = await resolve({ ...target, directPolicy: "block" });
  expect(result).toMatchObject({ ok: false, deliverySuppressionReason: "channel_transform" });
  expect(sourcePlan(result, target).messageTool.enabled).toBe(false);
});
