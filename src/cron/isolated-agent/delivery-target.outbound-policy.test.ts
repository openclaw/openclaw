import { afterEach, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { withTempCronHome } from "../isolated-agent.test-harness.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("delivers an allowed implicit cron directory recipient and stops a denied one before transport", async () => {
  await withTempCronHome(async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "alpha", messageId: "sent-1" });
    const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
      to === "denied-room" && allowFrom?.length
        ? { ok: false as const, error: new Error("cron target denied") }
        : { ok: true as const, to: to ?? "" },
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "alpha",
              outbound: {
                deliveryMode: "direct",
                resolveTarget,
                sendText,
                sendMedia: sendText,
              },
              capabilities: { chatTypes: ["group"] },
              messaging: { targetPrefixes: ["alpha"] },
            }),
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({}),
              resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) =>
                (cfg.channels?.alpha as { allowFrom?: string[] } | undefined)?.allowFrom,
            },
            directory: {
              listGroups: async () => [
                {
                  kind: "group",
                  id: "allowed-room",
                  name: "allowed",
                } satisfies ChannelDirectoryEntry,
                {
                  kind: "group",
                  id: "denied-room",
                  name: "alpha",
                } satisfies ChannelDirectoryEntry,
              ],
            },
          },
        },
      ]),
    );

    const cfg = {
      bindings: [],
      channels: { alpha: { allowFrom: ["alpha"] } },
    } as OpenClawConfig;
    const runCase = async (to: string) => {
      const resolvedDelivery = await resolveDeliveryTarget(
        cfg,
        "agent-b",
        { channel: "last" },
        {
          sessionContext: {
            mainSessionKey: "agent:agent-b:main",
            main: {
              sessionId: `cron-final-effect-${to}`,
              updatedAt: 1,
              delivery: normalizeSessionDeliveryState({ context: { channel: "alpha", to } }),
            },
            usedSharedMainFallback: false,
          },
        },
      );
      const delivery = { mode: "announce" as const };
      return dispatchCronDelivery({
        cfgWithAgentDefaults: cfg,
        deps: {},
        job: {
          id: `final-effect-${to}`,
          name: "Final effect policy test",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          deleteAfterRun: false,
          delivery,
          payload: { kind: "agentTurn", message: "test" },
          state: {},
        },
        agentId: "agent-b",
        agentSessionKey: `agent:agent-b:cron:final-effect-${to}`,
        runSessionKey: `agent:agent-b:cron:final-effect-${to}`,
        sessionId: `cron-final-effect-${to}`,
        lifecycleRevision: "test-revision",
        sessionUpdatedAt: 1,
        runStartedAt: 1,
        timeoutMs: 30_000,
        resolvedDelivery,
        deliveryPlan: resolveCronDeliveryPlan({ delivery }),
        deliveryRequested: true,
        undeliveredRunStatus: "ok",
        spawnOnlyHandoff: false,
        sourceDeliveryOutcome: {
          visibleDeliveries: [],
          verifiedMessageToolDelivery: false,
          satisfiesSourceDelivery: false,
          unverifiedMessageToolDelivery: false,
        },
        deliveryBestEffort: false,
        deliveryPayloadHasStructuredContent: false,
        deliveryPayloads: [{ text: "scheduled update" }],
        synthesizedText: "scheduled update",
        summary: "scheduled update",
        outputText: "scheduled update",
        isAborted: () => false,
        abortReason: () => "aborted",
      });
    };

    const allowed = await runCase("allowed");
    expect(allowed.delivered).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: "allowed-room", text: "scheduled update" }),
    );

    const denied = await runCase("alpha");
    expect(denied.delivered).toBe(false);
    expect(denied.deliveryError).toBe("cron target denied");
    expect(sendText).toHaveBeenCalledOnce();
    expect(resolveTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "denied-room", mode: "implicit", allowFrom: ["alpha"] }),
    );
  });
});
