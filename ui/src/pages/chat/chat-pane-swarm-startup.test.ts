/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

it.each(
  (["snapshot", "selection"] as const).flatMap((transition) =>
    (["connect", "retry"] as const).map((phase) => ({ phase, transition })),
  ),
)(
  "retires an old global agent's pending $phase during $transition while the next foreground chat holds hydration",
  async ({ phase, transition }) => {
    vi.useFakeTimers();
    const parentAgents: unknown[] = [];
    const childParents: unknown[] = [];
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "global" as const,
      agents: [{ id: "main" }, { id: "research" }],
    };
    const client = createTestGatewayClient(async (method, raw) => {
      const params = asOptionalRecord(raw);
      if (method === "sessions.describe" && params?.key === "global") {
        parentAgents.push(params.agentId);
        if (phase === "retry" && params.agentId === "main") {
          throw new Error("temporary parent read failure");
        }
        return { session: null };
      }
      if (method === "sessions.list") {
        if (params?.spawnedBy) {
          childParents.push(params.spawnedBy);
        }
        return sessionsResult([], 1);
      }
      const responses = new Map<string, unknown>([
        ["models.list", { models: [] }],
        ["agents.list", agents],
        ["agent.identity.get", { agentId: params?.agentId, name: "Assistant" }],
        ["sessions.subscribe", { subscribed: true }],
      ]);
      return responses.get(method) ?? {};
    });
    const { pane, state } = createTestChatPane({ client });
    Object.assign(state, { sessionKey: "global", assistantAgentId: "main", agentsList: agents });
    pane.sessionKey = "global";
    const snapshot = {
      ...pane.context.gateway.snapshot,
      assistantAgentId: "main",
      hello: {
        ...state.hello!,
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "global",
            scope: "global",
          },
        },
      },
    };
    const coordinator = pane.context.connectionBootstrap;
    try {
      pane.applyGatewaySnapshot(snapshot);
      if (transition === "selection") {
        const services = {
          config: createApplicationConfigCapability({ resourceBasePath: "" }),
          runtimeConfig: createRuntimeConfigCapability(pane.context.gateway),
          placementStartup: createApplicationPlacementStartup(pane.context),
        };
        Object.assign(pane.context, services);
        onTestFinished(() => {
          services.runtimeConfig.dispose();
          services.placementStartup.dispose();
        });
        pane.connectedCallback();
      }
      await import("../../lib/sessions/swarm-roster.ts");
      await vi.dynamicImportSettled();
      if (phase === "retry") {
        await vi.waitFor(() => expect(parentAgents).toEqual(["main"]));
        parentAgents.length = 0;
        childParents.length = 0;
      }

      coordinator.setForegroundRoute(undefined);
      pane.context.agentSelection.set("research");
      if (transition === "snapshot") {
        pane.applyGatewaySnapshot(snapshot);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect({ parentAgents, childParents }).toEqual({ parentAgents: [], childParents: [] });

      coordinator.setForegroundRoute(null);
      await vi.waitFor(() => expect(parentAgents).toEqual(["research"]));
      expect(childParents).toEqual(["global"]);
    } finally {
      coordinator.reset();
      vi.useRealTimers();
    }
  },
);
