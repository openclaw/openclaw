import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability, reconcileSessionRunTerminal } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"], ts: number): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createSessionCapability", () => {
  it("passes transcript fork parameters to sessions.create", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key: "agent:main:forked" };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:source",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await expect(
      sessions.create({
        agentId: "main",
        parentSessionKey: "agent:main:source",
        fork: true,
      }),
    ).resolves.toBe("agent:main:forked");
    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "main",
      parentSessionKey: "agent:main:source",
      fork: true,
    });
    sessions.dispose();
  });

  it("keeps background hydration non-blocking and retains an omitted selected row", async () => {
    const secondList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls === 1) {
        return sessionsResult(
          [
            {
              key: "agent:main:oldest",
              kind: "direct",
              updatedAt: 1,
              label: "Oldest",
            },
          ],
          1,
        );
      }
      return await secondList.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:oldest",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    };
    const sessions = createSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const loadingStates: boolean[] = [];
    const stop = sessions.subscribe((state) => loadingStates.push(state.loading));

    const hydration = sessions.refresh({
      agentId: "main",
      backgroundHydrate: true,
      force: true,
    });
    expect(sessions.state.loading).toBe(false);
    secondList.resolve(sessionsResult([], 2));
    await hydration;

    expect(loadingStates).not.toContain(true);
    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({ key: "agent:main:oldest", label: "Oldest" }),
    ]);
    stop();
    sessions.dispose();
  });

  it("publishes terminal run state to shared session subscribers", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
            startedAt: 100,
          },
        ],
        1,
      );
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: key,
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    await sessions.refresh({ agentId: "main", force: true });

    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 160,
      }),
    ).toBe(true);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      key,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
      endedAt: 160,
      runtimeMs: 60,
    });

    expect(
      sessions.reconcile({
        key,
        kind: "direct",
        updatedAt: 2,
        hasActiveRun: true,
        activeRunIds: ["run-2"],
        status: "running",
        startedAt: 200,
      }),
    ).toBe(true);
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 260,
      }),
    ).toBe(false);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["run-2"],
      status: "running",
    });

    expect(
      sessions.reconcile({
        key,
        kind: "direct",
        updatedAt: 3,
        hasActiveRun: true,
        status: "running",
        startedAt: 300,
      }),
    ).toBe(true);
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 360,
      }),
    ).toBe(false);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      status: "running",
    });
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        status: "done",
        endedAt: 360,
      }),
    ).toBe(false);
    sessions.dispose();
  });

  it("preserves registry-active terminal rows without matching run identity", () => {
    const result = sessionsResult(
      [
        {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          status: "done",
        },
      ],
      1,
    );

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 160,
      }),
    ).toBe(result);
  });

  it("refreshes stale active rows after a terminal session message", async () => {
    const key = "agent:main:main";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        sessionsResult(
          [{ key, kind: "direct", updatedAt: 1, hasActiveRun: true, status: "running" }],
          1,
        ),
      )
      .mockResolvedValueOnce(
        sessionsResult(
          [{ key, kind: "direct", updatedAt: 2, hasActiveRun: false, status: "done" }],
          2,
        ),
      );
    let eventListener: ((event: GatewayEventFrame) => void) | undefined;
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        connected: true,
        sessionKey: key,
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
        eventListener = listener;
        return () => undefined;
      },
    };
    const sessions = createSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });

    eventListener?.({
      type: "event",
      event: "session.message",
      payload: { sessionKey: key, updatedAt: 1, status: "done" },
    });

    await vi.waitFor(() =>
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        key,
        hasActiveRun: false,
        status: "done",
      }),
    );
    expect(request).toHaveBeenCalledTimes(2);
    sessions.dispose();
  });
});
