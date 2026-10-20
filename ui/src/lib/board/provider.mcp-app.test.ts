// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import {
  boardClient,
  boardSnapshot,
  boardWidget,
  mainTab,
} from "./provider.lease-cases.test-support.ts";

beforeEach(() => {
  vi.stubGlobal("location", { search: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mcpAppSnapshot(sessionKey: string) {
  return boardSnapshot(sessionKey, 1, {
    tabs: [mainTab],
    widgets: [boardWidget("server-app", { contentKind: "mcp-app", instanceId: "app-instance" })],
  });
}

describe("board provider MCP App views", () => {
  it.each([
    { session: { sessionKey: "agent:main:app" }, acknowledgedKey: "agent:main:app" },
    { session: { sessionKey: "global", agentId: "work" }, acknowledgedKey: "agent:work:global" },
  ])(
    "deduplicates scoped $session app leases until an explicit refresh",
    async ({ session, acknowledgedKey }) => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const snapshot = mcpAppSnapshot(acknowledgedKey);
      let lease = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "board.get") {
          return snapshot;
        }
        if (method === "board.widget.appView") {
          lease += 1;
          return { viewId: `mcp-app-${lease}`, expiresAtMs: lease === 1 ? 10_000 : 20_000 };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const provider = new GatewayBoardProvider(session, boardClient(request));
      await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));

      await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
        status: "ready",
        viewId: "mcp-app-1",
      });
      expect(request).toHaveBeenCalledWith("board.widget.appView", {
        ...session,
        name: "server-app",
        revision: 1,
        instanceId: "app-instance",
      });
      await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
        viewId: "mcp-app-1",
      });
      now = 6_000;
      await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
        status: "ready",
        viewId: "mcp-app-1",
      });
      await expect(provider.refreshWidgetAppView("server-app", 1)).resolves.toMatchObject({
        status: "ready",
        viewId: "mcp-app-2",
      });
      expect(
        request.mock.calls.filter(([method]) => method === "board.widget.appView"),
      ).toHaveLength(2);
    },
  );

  it("does not reuse a cached lease for a same-name replacement", async () => {
    const cache = new BoardMcpAppViewCache();
    const widget = boardWidget("server-app", { contentKind: "mcp-app", instanceId: "instance-a" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ viewId: "view-a", expiresAtMs: Date.now() + 60_000 })
      .mockResolvedValueOnce({ viewId: "view-b", expiresAtMs: Date.now() + 60_000 });

    await expect(cache.resolve(widget, request, false)).resolves.toHaveProperty("viewId", "view-a");
    await expect(
      cache.resolve({ ...widget, instanceId: "instance-b" }, request, false),
    ).resolves.toHaveProperty("viewId", "view-b");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached lease after a same-client reconnect", async () => {
    const snapshot = mcpAppSnapshot("agent:main:reconnected-app");
    let lease = 0;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "board.get") {
          return snapshot;
        }
        lease += 1;
        return { viewId: `view-${lease}`, expiresAtMs: Date.now() + 60_000 };
      }) as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client);
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));
    await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
      viewId: "view-1",
    });

    provider.attachClient(client, false);
    provider.attachClient(client, true);

    await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
      viewId: "view-2",
    });
  });

  it("rejects pending leases after replacement, reconnect, and disposal", async () => {
    for (const transition of ["replacement", "reconnect", "disposal"] as const) {
      const sessionKey = `agent:main:app-view-${transition}`;
      const snapshot = mcpAppSnapshot(sessionKey);
      const lease = createDeferred<{ viewId: string; expiresAtMs: number }>();
      const client = boardClient(
        vi.fn((method: string) =>
          method === "board.get" ? Promise.resolve(snapshot) : lease.promise,
        ),
      );
      const provider = new GatewayBoardProvider({ sessionKey }, client);
      await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));

      const pending = provider.widgetAppView("server-app", 1);
      await vi.waitFor(() =>
        expect(client.request).toHaveBeenCalledWith("board.widget.appView", expect.any(Object)),
      );
      if (transition === "replacement") {
        provider.attachClient(boardClient(vi.fn(async () => snapshot)), true);
      } else if (transition === "reconnect") {
        provider.attachClient(client, false);
        provider.attachClient(client, true);
      } else {
        provider.dispose();
      }
      lease.resolve({ viewId: "retired-view", expiresAtMs: Date.now() + 60_000 });

      await expect(pending).resolves.toEqual({
        status: "stale",
      });
    }
  });

  it("contains re-mint failures as stale widget state and retries on demand", async () => {
    const snapshot = mcpAppSnapshot("agent:main:stale-app");
    snapshot.widgets[0]!.instanceId = "stale-app-instance";
    let attempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "board.get") {
        return snapshot;
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("origin transcript pruned");
      }
      return { viewId: "mcp-app-restored", expiresAtMs: Date.now() + 60_000 };
    });
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:stale-app" },
      boardClient(request),
    );
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));

    await expect(provider.widgetAppView("server-app", 1)).resolves.toEqual({
      status: "stale",
    });
    await expect(provider.refreshWidgetAppView("server-app", 1)).resolves.toMatchObject({
      status: "ready",
      viewId: "mcp-app-restored",
    });
  });
});
