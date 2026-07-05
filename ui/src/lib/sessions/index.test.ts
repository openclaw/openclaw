import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

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
});
