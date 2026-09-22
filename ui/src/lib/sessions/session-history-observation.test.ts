// @vitest-environment node
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["unloaded", "absent", "present"] as const)(
  "preserves newer observed metadata while accepting history (primary row: %s)",
  async (primary) => {
    const settled: GatewaySessionRow = {
      key: "agent:main:parent",
      sessionId: "parent-session",
      kind: "direct",
      updatedAt: 3,
      status: "done",
      hasActiveRun: false,
    };
    const client = createTestGatewayClient(async (method) =>
      method === "sessions.list"
        ? sessionsResult(primary === "present" ? [settled] : [], 3)
        : { subscribed: true },
    );
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    try {
      if (primary === "unloaded") {
        expect(sessions.state.result).toBeNull();
      } else {
        await sessions.refresh({ agentId: "main", force: true });
        expect(sessions.state.result?.sessions.some((row) => row.key === settled.key)).toBe(
          primary === "present",
        );
      }
      const observation = sessions.observeRow({ key: settled.key, agentId: "main" }, () => {});
      expect(observation.captureReconcile()(settled)).toMatchObject({ status: "current" });
      expect(observation.row).toMatchObject(settled);

      const olderHistory = {
        ...settled,
        updatedAt: 2,
        status: "running" as const,
        hasActiveRun: true,
      };
      const pendingRead = observation.captureReconcile();
      const reconcileHistory = sessions.captureReconcile();
      expect(reconcileHistory(olderHistory, undefined, { resultAgentId: "main" })).toBe(true);
      expect(observation.row).toMatchObject(settled);

      // Ignoring stale metadata must not retire an already pending descriptor read.
      const next = { ...settled, updatedAt: 4, label: "Fresh descriptor" };
      expect(pendingRead(next)).toMatchObject({ status: "current" });
      expect(observation.row).toMatchObject(next);

      const newerHistory = { ...olderHistory, updatedAt: 5 };
      expect(sessions.captureReconcile()(newerHistory, undefined, { resultAgentId: "main" })).toBe(
        true,
      );
      expect(observation.row).toMatchObject(newerHistory);
    } finally {
      sessions.dispose();
    }
  },
);
