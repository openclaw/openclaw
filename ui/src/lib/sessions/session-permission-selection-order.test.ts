// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

it.each(["success", "failure", "dynamic"] as const)(
  "preserves a queued selection across a permission acknowledgment (%s)",
  async (outcome) => {
    const key = "agent:main:permission-selection";
    const sessionId = "permission-selection-generation";
    const initial = sessionsResult(
      [{ key, kind: "direct", sessionId, updatedAt: 1, permissionMode: "guarded" }],
      1,
    );
    const blocker = createDeferred<SessionsListResult>();
    const selected = createDeferred<SessionsListResult>();
    const queries: Array<unknown> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "(sessions)",
          key,
          entry: { sessionId, updatedAt: 2, permissionMode: "workspace" },
        };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      queries.push(asOptionalRecord(params)?.agentId);
      return queries.length === 1
        ? initial
        : queries.length === 2
          ? blocker.promise
          : selected.promise;
    });
    const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
    vi.spyOn(client, "request").mockImplementation(request);
    const harness = createGatewayHarness(client);
    const listeners = new Set<() => void>();
    const state = { selectedId: "main" };
    const sessions = createSessionCapability(harness.gateway, {
      state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const select = (agentId: string) => {
      state.selectedId = agentId;
      listeners.forEach((listener) => listener());
    };
    const pending: Array<Promise<unknown>> = [];
    try {
      harness.publish(true);
      await vi.waitFor(() => expect(sessions.state.result?.sessions[0]?.key).toBe(key));
      pending.push(sessions.refresh({ agentId: "main", force: true }));
      select("writer");
      if (outcome === "dynamic") {
        select("main");
      }
      const patch = sessions.patch(key, { permissionMode: "workspace" });
      pending.push(patch);
      await vi.waitFor(() =>
        expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("workspace"),
      );
      if (outcome === "dynamic") {
        // The selection supplier is live when the queued request drains.
        state.selectedId = "writer";
        harness.emitEvent({
          type: "event",
          event: "session.message",
          payload: {
            key,
            sessionKey: key,
            kind: "direct",
            sessionId,
            updatedAt: 3,
            permissionMode: "full",
            archived: false,
            hasActiveRun: true,
            status: "running",
          },
        });
      }
      blocker.resolve(initial);
      await vi.waitFor(() => expect(queries).toHaveLength(3));
      expect(queries).toEqual(["main", "main", "writer"]);
      if (outcome === "success") {
        selected.resolve(sessionsResult([{ key: "agent:writer:chat", kind: "direct" }], 3));
      } else {
        selected.reject(new Error("Writer roster unavailable"));
      }
      await Promise.all(pending);
      expect(sessions.state.loading).toBe(false);
      if (outcome === "success") {
        expect(sessions.state.agentId).toBe("writer");
      } else {
        expect(sessions.state.error).toBe("Writer roster unavailable");
      }
      await expect(patch).resolves.not.toHaveProperty("listRefreshError");
    } finally {
      blocker.resolve(initial);
      selected.resolve(initial);
      await Promise.allSettled(pending);
      sessions.dispose();
    }
  },
);
