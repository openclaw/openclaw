import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createCronTool } from "./cron-tool.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";

it("infers cron creation delivery from the selected global session owner", async () => {
  await withOpenClawTestState({ label: "cron-creation-delivery-owner" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
      session: { scope: "global" },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
    const routes = {
      main: { channel: "telegram", to: "telegram:main", accountId: "main", threadId: "11" },
      ops: { channel: "telegram", to: "telegram:ops", accountId: "ops", threadId: "22" },
    };
    for (const [agentId, context] of Object.entries(routes)) {
      await replaceSessionEntry(
        { agentId, sessionKey: "global", env: state.env },
        {
          sessionId: `${agentId}-global`,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context }),
        },
      );
    }
    const gatewayBoundary = new Error("captured cron.add request");
    const callGatewayTool = vi
      .fn<(...args: Parameters<GatewayToolCaller>) => Promise<never>>()
      .mockRejectedValue(gatewayBoundary);
    const tool = createCronTool(
      { agentSessionKey: "global", agentId: "ops", currentDeliveryContext: {} },
      { callGatewayTool },
    );

    await expect(
      tool.execute("create-global-job", {
        action: "add",
        job: {
          name: "Owned reminder",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Send the reminder." },
        },
      }),
    ).rejects.toBe(gatewayBoundary);

    expect(callGatewayTool).toHaveBeenCalledExactlyOnceWith(
      "cron.add",
      expect.any(Object),
      expect.objectContaining({ delivery: { mode: "announce", ...routes.ops } }),
    );
  });
});
