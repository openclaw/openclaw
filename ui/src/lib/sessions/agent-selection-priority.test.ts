// @vitest-environment node
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");

it.each([false, true])(
  "dispatches deliberate selection before transcript readiness (obsolete list pending: %s)",
  async (obsoletePending) => {
    vi.useFakeTimers();
    const pendingWriter = createDeferred<SessionsListResult>();
    const reads: string[] = [];
    const result = (agentId: string) =>
      sessionsResult([{ key: `agent:${agentId}:main`, kind: "direct", updatedAt: 1 }], 1);
    const client = createTestGatewayClient(async (method, params) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const agentId = requireRecord(params, "sessions.list params").agentId;
      if (typeof agentId !== "string") {
        throw new Error("Session query has no agent owner");
      }
      reads.push(agentId);
      return agentId === "writer" && obsoletePending ? pendingWriter.promise : result(agentId);
    });
    const { gateway, publish } = createGatewayHarness(client);
    const selection = createAgentSelectionCapability(
      { ...gateway, connection: { gatewayUrl: "ws://gateway.example.test" } },
      {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main" }, { id: "writer" }],
          },
        },
        subscribe: () => () => undefined,
      },
    );
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client, connected: true });
    coordinator.setForegroundRoute("agent:main:main");
    const sessions = createSessionCapability(gateway, selection, {
      connectionBootstrap: coordinator,
    });
    try {
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
      // Automatic connection hydration retains the selected-history priority.
      expect(reads).toEqual([]);
      // Initial route binding changes agent ownership but keeps automatic lists queued.
      selection.set("writer", { background: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual([]);
      selection.set("main", { background: true });
      coordinator.setForegroundPane({}, { sessionKey: "agent:main:main", client, ready: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(["main"]);
      if (obsoletePending) {
        selection.set("writer");
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toEqual(["main", "writer"]);
      }
      const target = obsoletePending ? "main" : "writer";
      coordinator.setForegroundRoute(`agent:${target}:main`);
      coordinator.setForegroundPane(
        {},
        { sessionKey: `agent:${target}:main`, client, ready: false },
      );
      selection.set(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(obsoletePending ? ["main", "writer", "main"] : ["main", "writer"]);
      expect(sessions.state).toMatchObject({ agentId: target, result: result(target) });
      pendingWriter.resolve(result("writer"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.agentId).toBe(target);
    } finally {
      pendingWriter.resolve(result("writer"));
      sessions.dispose();
      selection.dispose();
      coordinator.reset();
      vi.useRealTimers();
    }
  },
);
