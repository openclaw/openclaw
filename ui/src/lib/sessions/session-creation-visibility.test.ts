// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["local", "event"] as const)(
  "shows %s-created sessions independently of primary reconciliation, pacing only remote events",
  async (origin) => {
    vi.useFakeTimers();
    const primary = createDeferred<SessionsListResult>();
    const old = {
      key: "agent:main:older",
      sessionId: "older",
      kind: "direct" as const,
      updatedAt: 1,
    };
    const created = {
      key: "agent:main:created",
      sessionId: "created",
      kind: "direct" as const,
      updatedAt: 2,
    };
    let committed = false;
    const client = createTestGatewayClient(async (method, raw) => {
      if (method === "sessions.create") {
        committed = true;
        return { key: created.key, entry: created };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method !== "sessions.list") {
        throw new Error("Unexpected request: " + method);
      }
      const params = raw as { ownerId?: string; involvingMe?: boolean; search?: string };
      if (committed && !params.ownerId && !params.involvingMe && !params.search) {
        return primary.promise;
      }
      const rows = committed && !params.search ? [created, old] : [old];
      return sessionsResult(rows, committed ? 2 : 1);
    });
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const queries = [{ ownerId: "viewer" }, { involvingMe: true }, { search: "older" }];
    const stops = queries.map((query) => sessions.subscribeList(query, () => {}));
    try {
      await sessions.refresh({ agentId: "main", force: true });
      for (const query of queries) {
        await sessions.refreshList(query);
      }
      if (origin === "local") {
        await sessions.createResult({ agentId: "main" }, { reconciliation: "background" });
      } else {
        committed = true;
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey: created.key, reason: "create", session: created },
        });
      }
      await vi.advanceTimersByTimeAsync(origin === "local" ? 0 : 5_000);
      for (const query of queries.slice(0, 2)) {
        expect(sessions.listSnapshot(query).result?.sessions.map((row) => row.key)).toEqual([
          created.key,
          old.key,
        ]);
      }
      expect(sessions.listSnapshot(queries[2]!).result?.sessions.map((row) => row.key)).toEqual([
        old.key,
      ]);
    } finally {
      primary.resolve(sessionsResult([created, old], 2));
      stops.forEach((stop) => stop());
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
