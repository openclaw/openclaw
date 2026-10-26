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

it("resolves the requested owner channel/account without inheriting heartbeat policy or a group", async () => {
  const result = await resolveDeliveryTarget(
    cfg,
    "main",
    { target: "owner", channel: "beta", accountId: "secondary" },
    { sessionContext },
  );
  expect(result).toMatchObject({
    ok: true,
    channel: "beta",
    to: "user:bob",
    accountId: "secondary",
    mode: "explicit",
  });
});

it.each([
  { name: "missing owner", config: { ...cfg, commands: {} }, accountId: undefined },
  { name: "unknown owner account", config: cfg, accountId: "missing" },
])("does not route $name to a remembered group or enable the message tool", async (row) => {
  const result = await resolveDeliveryTarget(
    row.config,
    "main",
    { target: "owner", accountId: row.accountId },
    { sessionContext },
  );
  expect(result).toMatchObject({ ok: false, channel: "none", mode: "explicit" });
  expect(result.to).toBeUndefined();
  const plan = resolveCronSourceDeliveryPlan({
    deliveryPlan: { mode: "announce", target: "owner", requested: true, source: "delivery" },
    resolvedDelivery: result,
  });
  expect(plan.messageTool.enabled).toBe(false);
  expect(plan.fallback.skipWhenMessageToolSentToTarget).toBe(false);
});

it.each([
  { name: "owner", target: "owner" as const, channel: "beta" },
  { name: "explicit", channel: "beta", to: "user:bob" },
])("reports intentional DM suppression for $name delivery", async ({ name: _name, ...target }) => {
  const result = await resolveDeliveryTarget(
    cfg,
    "main",
    { ...target, directPolicy: "block" },
    { sessionContext },
  );
  expect(result).toMatchObject({ ok: false, deliverySuppressionReason: "channel_transform" });
  const plan = resolveCronSourceDeliveryPlan({
    deliveryPlan: { ...target, mode: "announce", requested: true, source: "delivery" },
    resolvedDelivery: result,
  });
  expect(plan.messageTool.enabled).toBe(false);
});
