/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const swarmImport = vi.hoisted(() => {
  let release!: () => void;
  let markStarted!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    release: () => release(),
    markStarted: () => markStarted(),
  };
});

vi.mock("../../lib/sessions/swarm-roster.ts", async (importOriginal) => {
  swarmImport.markStarted();
  await swarmImport.held;
  return importOriginal();
});

function createGlobalPane(failMainParent = false) {
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
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "agents.list") {
      return agents;
    }
    if (method === "agent.identity.get") {
      return { agentId: params?.agentId, name: "Assistant" };
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.describe" && params?.key === "global") {
      parentAgents.push(params.agentId);
      if (failMainParent && params.agentId === "main") {
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
    return {};
  });
  const { pane, state } = createTestChatPane({ client });
  state.sessionKey = "global";
  state.assistantAgentId = "main";
  state.agentsList = agents;
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
  return { pane, state, snapshot, coordinator, parentAgents, childParents };
}

describe("global pane Swarm startup ownership", () => {
  it("admits the latest agent after a stale module load without bypassing its foreground hold", async () => {
    vi.useFakeTimers();
    const { pane, state, snapshot, coordinator, parentAgents, childParents } = createGlobalPane();
    try {
      pane.applyGatewaySnapshot(snapshot);
      await swarmImport.started;
      pane.context.agentSelection.set("research");
      pane.applyGatewaySnapshot(snapshot);
      expect(state.sessionKey).toBe("global");
      expect(state.assistantAgentId).toBe("research");

      coordinator.setForegroundRoute(undefined);
      swarmImport.release();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(500);
      expect(parentAgents).toEqual([]);
      expect(childParents).toEqual([]);

      coordinator.setForegroundRoute(null);
      await vi.waitFor(() => {
        expect(parentAgents).toEqual(["research"]);
        expect(childParents).toEqual(["global"]);
      });
    } finally {
      swarmImport.release();
      coordinator.reset();
      vi.useRealTimers();
    }
  });

  it.each([
    { phase: "connect", transition: "snapshot" },
    { phase: "retry", transition: "snapshot" },
    { phase: "connect", transition: "selection" },
    { phase: "retry", transition: "selection" },
  ] as const)(
    "retires an old global agent's pending $phase during $transition while the next foreground chat holds hydration",
    async ({ phase, transition }) => {
      vi.useFakeTimers();
      swarmImport.release();
      const { pane, snapshot, coordinator, parentAgents, childParents } = createGlobalPane(
        phase === "retry",
      );
      try {
        pane.applyGatewaySnapshot(snapshot);
        if (transition === "selection") {
          const runtimeConfig = createRuntimeConfigCapability(pane.context.gateway);
          const placementStartup = createApplicationPlacementStartup(pane.context);
          Object.assign(pane.context, {
            config: createApplicationConfigCapability({ resourceBasePath: "" }),
            runtimeConfig,
            placementStartup,
            plugins: new ControlUiPluginRuntime(() => pane.context),
          });
          onTestFinished(() => {
            runtimeConfig.dispose();
            placementStartup.dispose();
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
        expect(parentAgents).toEqual([]);
        expect(childParents).toEqual([]);

        coordinator.setForegroundRoute(null);
        await vi.waitFor(() => expect(parentAgents).toEqual(["research"]));
        expect(childParents).toEqual(["global"]);
      } finally {
        coordinator.reset();
        vi.useRealTimers();
      }
    },
  );
});
