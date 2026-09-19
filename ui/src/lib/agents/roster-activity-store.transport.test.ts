/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createContext, createSessionsHarness } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { rosterActivityStore } from "./roster-activity-store.ts";

function snapshot(preview: string, hasMore = false): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions: [{ key: "agent:main:main", kind: "direct", lastMessagePreview: preview }],
    hasMore,
  };
}

function fixture() {
  const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
  const protocol = new GatewayPendingRequests({ createRequestId: () => "roster", nowMs: Date.now });
  const client = createTestGatewayClient((method, params, options) =>
    protocol.request(
      {
        send(frame) {
          const request = JSON.parse(frame);
          if (request.method === "sessions.subscribe") {
            protocol.handleResponse({
              type: "res",
              id: request.id,
              ok: true,
              payload: { subscribed: true },
            });
          } else if (request.method === "sessions.list") {
            requests.push(request);
          } else {
            throw new Error(`Unexpected RPC: ${request.method}`);
          }
        },
      },
      method,
      params,
      options,
    ),
  );
  const source = createApplicationGateway({
    client,
    phase: "connected",
    hello: null,
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  });
  const context = createContext(source.gateway, createSessionsHarness("main", []).sessions, {
    agents: [{ id: "main" }],
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  });
  return {
    store: rosterActivityStore(context),
    source,
    requests,
    invalidate() {
      source.publishEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId: "main", key: "agent:main:new" },
      });
    },
    respond(index: number, preview: string, hasMore = false) {
      const request = requests[index];
      if (!request) {
        throw new Error(`Missing roster request ${index}`);
      }
      protocol.handleResponse({
        type: "res",
        id: request.id,
        ok: true,
        payload: snapshot(preview, hasMore),
      });
    },
    close() {
      protocol.flush(new Error("fixture closed"));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["pending", "settled"] as const)(
  "keeps the %s roster window through recap-only updates",
  async (phase) => {
    vi.useFakeTimers();
    const f = fixture();
    const detach = f.store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "settled") {
        f.respond(0, "Current activity");
        await vi.advanceTimersByTimeAsync(0);
      }
      f.source.publishEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:main",
          agentId: "main",
          reason: "activity-summary",
          session: {
            key: "agent:main:main",
            kind: "direct",
            lastMessagePreview: "Current activity",
          },
        },
      });
      await vi.advanceTimersByTimeAsync(250);
      if (phase === "pending") {
        f.respond(0, "Current activity");
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.requests).toHaveLength(1);
      expect(f.store.snapshot.cards[0]?.preview).toBe("Current activity");
      expect(f.store.snapshot.loading).toBe(false);

      f.invalidate();
      await vi.advanceTimersByTimeAsync(250);
      expect(f.requests).toHaveLength(2);
      f.respond(1, "Refreshed membership");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.snapshot.cards[0]?.preview).toBe("Refreshed membership");
    } finally {
      detach();
      f.close();
    }
  },
);

it("coalesces repeated invalidations behind one correlated roster request", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const detach = f.store.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) {
      f.invalidate();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(f.requests).toHaveLength(1);
    f.respond(0, "Stale page", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.params.offset).toBeUndefined();
    expect(f.store.snapshot.result).toBeNull();
    f.respond(1, "Fresh window");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Fresh window");
    expect(f.requests).toHaveLength(2);
  } finally {
    detach();
    f.close();
  }
});

it("revokes pagination immediately while the replacement debounce is pending", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const detach = f.store.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    f.invalidate();
    f.respond(0, "Invalidated page", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.params.offset).toBeUndefined();
    f.respond(1, "Current page");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Current page");
  } finally {
    detach();
    f.close();
  }
});

it("absorbs a newer debounce when the queued window starts", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const detach = f.store.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    f.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    f.invalidate();
    f.respond(0, "Old window", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    f.respond(1, "Latest window");
    await vi.advanceTimersByTimeAsync(250);
    expect(f.requests).toHaveLength(2);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Latest window");
    expect(f.store.snapshot.loading).toBe(false);
  } finally {
    detach();
    f.close();
  }
});

it("retains raw ownership across filter round trips and never continues revoked pagination", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const detach = f.store.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (const involvingMe of [true, false, true]) {
      f.store.setInvolvingMe(involvingMe);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.requests).toHaveLength(1);
    f.respond(0, "Old filter", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.params).toMatchObject({ involvingMe: true, limit: 100, archived: "all" });
    expect(f.requests[1]?.params.offset).toBeUndefined();
    f.respond(1, "Current filter");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Current filter");
  } finally {
    detach();
    f.close();
  }
});

it.each([false, true])(
  "retires detached demand while retaining transport (reattach: %s)",
  async (reattach) => {
    vi.useFakeTimers();
    const f = fixture();
    let detach = f.store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      detach();
      expect(f.store.snapshot.cards).toEqual([]);
      if (reattach) {
        detach = f.store.subscribe(() => {});
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(1);
      f.respond(0, "Retired page", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(reattach ? 2 : 1);
      if (reattach) {
        expect(f.requests[1]?.params.offset).toBeUndefined();
        f.respond(1, "Remounted window");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.store.snapshot.cards[0]?.preview).toBe("Remounted window");
      } else {
        expect(f.store.snapshot.cards).toEqual([]);
      }
    } finally {
      detach();
      f.close();
    }
  },
);

it("defers initial and event-driven roster loads while the document is hidden", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const f = fixture();
  const detach = f.store.subscribe(() => {});
  try {
    for (let i = 0; i < 8; i++) {
      f.invalidate();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(f.requests).toHaveLength(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    f.respond(0, "Visible window");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.snapshot.cards[0]?.preview).toBe("Visible window");
  } finally {
    detach();
    f.close();
  }
});

it.each([false, true])(
  "retains a same-client raw request through reconnect (detached: %s)",
  async (detached) => {
    vi.useFakeTimers();
    const f = fixture();
    let detach = f.store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (detached) {
        detach();
      }
      f.source.publish({ ...f.source.gateway.snapshot, phase: "reconnecting" });
      f.source.publish({ ...f.source.gateway.snapshot, phase: "connected" });
      if (detached) {
        detach = f.store.subscribe(() => {});
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(1);
      f.respond(0, "Old connection", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.params.offset).toBeUndefined();
      f.respond(1, "Current connection");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.snapshot.cards[0]?.preview).toBe("Current connection");
    } finally {
      detach();
      f.close();
    }
  },
);

it.each([false, true])(
  "resumes one fresh window after hiding pending work (reply while hidden: %s)",
  async (replyHidden) => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const f = fixture();
    const detach = f.store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 8; i++) {
        f.invalidate();
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(f.requests).toHaveLength(1);
      if (replyHidden) {
        f.respond(0, "Hidden page", true);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.requests).toHaveLength(1);
      }
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      if (!replyHidden) {
        expect(f.requests).toHaveLength(1);
        f.respond(0, "Revoked page", true);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.params.offset).toBeUndefined();
      f.respond(1, "Current window");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.snapshot.cards[0]?.preview).toBe("Current window");
    } finally {
      detach();
      f.close();
    }
  },
);
