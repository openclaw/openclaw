// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

function row(key: string, sessionId: string): GatewaySessionRow {
  return { key, kind: "direct", sessionId, updatedAt: 1, permissionMode: "guarded" };
}

function acknowledgment(key: string, sessionId: string) {
  return {
    ok: true,
    path: "(sessions)",
    key,
    entry: { sessionId, updatedAt: 2, permissionMode: "workspace" },
  };
}

function harness(
  initial: SessionsListResult,
  patchReply: unknown,
  list: (call: number) => Promise<SessionsListResult>,
) {
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      return patchReply;
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return ++listCalls === 1 ? initial : list(listCalls);
  });
  const capability = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
  );
  return {
    ...capability,
    calls: () => listCalls,
    mode: () => capability.sessions.state.result?.sessions[0]?.permissionMode,
    message: (
      key: string,
      sessionId: string,
      updatedAt: number,
      permissionMode: GatewaySessionRow["permissionMode"] | null = "full",
    ) =>
      capability.emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          key,
          sessionKey: key,
          kind: "direct",
          sessionId,
          updatedAt,
          permissionMode,
          archived: false,
          hasActiveRun: true,
          status: "running",
        },
      }),
  };
}

it.each(["workspace", "full", "failure"] as const)(
  "resolves conflicting equal-time permission facts through the owned canonical read (%s)",
  async (canonical) => {
    const key = "agent:main:permission-tie";
    const sessionId = "permission-tie-generation";
    const initial = sessionsResult([row(key, sessionId)], 1);
    const read = createDeferred<SessionsListResult>();
    const reply = createDeferred<unknown>();
    const { sessions, calls, message, mode } = harness(initial, reply.promise, () => read.promise);
    let patch: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ force: true });
      patch = sessions.patch(key, { permissionMode: "workspace" });
      message(key, sessionId, 2);
      reply.resolve(acknowledgment(key, sessionId));
      await vi.waitFor(() => expect(calls()).toBe(2));
      expect(mode()).toBe("full");
      if (canonical === "failure") {
        read.reject(new Error("Canonical read unavailable"));
        await expect(patch).resolves.toMatchObject({
          listRefreshError: "Canonical read unavailable",
        });
      } else {
        read.resolve(
          sessionsResult([{ ...row(key, sessionId), updatedAt: 2, permissionMode: canonical }], 2),
        );
        await patch;
      }
      expect(mode()).toBe(canonical === "failure" ? "full" : canonical);
      expect(sessions.state.loading).toBe(false);
      expect(calls()).toBe(2);
    } finally {
      read.resolve(initial);
      await patch;
      sessions.dispose();
    }
  },
);

it.each(["ordinary", "permission", "borrowed"] as const)(
  "keeps the latest queued %s refresh's error owner",
  async (lastOwner) => {
    const key = "agent:main:queued-permission";
    const sessionId = "queued-generation";
    const initial = sessionsResult([row(key, sessionId)], 1);
    const blocker = createDeferred<SessionsListResult>();
    const queued = createDeferred<SessionsListResult>();
    const { sessions, calls, message, mode } = harness(
      initial,
      acknowledgment(key, sessionId),
      (call) => (call === 2 ? blocker.promise : queued.promise),
    );
    const pending: Array<Promise<unknown>> = [];
    try {
      await sessions.refresh({ force: true });
      if (lastOwner !== "borrowed") {
        pending.push(sessions.refresh({ force: true }));
      }
      if (lastOwner === "permission") {
        pending.push(sessions.refresh({ force: true }));
      }
      const patch = sessions.patch(key, { permissionMode: "workspace" });
      pending.push(patch);
      await vi.waitFor(() => expect(mode()).toBe("workspace"));
      if (lastOwner !== "permission") {
        pending.push(sessions.refresh({ force: true }));
      }
      message(key, sessionId, 3);
      blocker.resolve(initial);
      await vi.waitFor(() => expect(calls()).toBe(3));
      expect(sessions.state.loading).toBe(true);
      queued.reject(new Error("Selected refresh unavailable"));
      await Promise.all(pending);
      expect(sessions.state.loading).toBe(false);
      expect(mode()).toBe("full");
      expect(sessions.state.error).toBe(
        lastOwner !== "permission" ? "Selected refresh unavailable" : null,
      );
      await expect(patch).resolves.not.toHaveProperty("listRefreshError");
      expect(calls()).toBe(3);
    } finally {
      blocker.resolve(initial);
      queued.resolve(initial);
      await Promise.allSettled(pending);
      sessions.dispose();
    }
  },
);

it("reports a permission refresh failure during another agent's active message", async () => {
  const key = "agent:main:permission-error";
  const sessionId = "permission-error-generation";
  const pending = createDeferred<SessionsListResult>();
  const { sessions, calls, message, mode } = harness(
    sessionsResult([row(key, sessionId)], 1),
    acknowledgment(key, sessionId),
    () => pending.promise,
  );
  try {
    await sessions.refresh({ force: true });
    const patch = sessions.patch(key, { permissionMode: "workspace" });
    await vi.waitFor(() => expect(calls()).toBe(2));
    message("agent:other:active", "other-generation", 3, null);
    pending.reject(new Error("Roster unavailable"));
    await expect(patch).resolves.toMatchObject({ listRefreshError: "Roster unavailable" });
    expect(sessions.state.error).toBe("Roster unavailable");
    expect(sessions.state.loading).toBe(false);
    expect(mode()).toBe("workspace");
  } finally {
    pending.resolve(sessionsResult([], 1));
    sessions.dispose();
  }
});
