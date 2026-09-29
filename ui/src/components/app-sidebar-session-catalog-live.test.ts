// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import { refetchExpandedSessionCatalogPages } from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [
        {
          threadId: `${id}-thread-${hostIndex}`,
          name: `Session ${hostIndex}`,
          status: "idle",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    })),
  };
}

describe("SessionCatalogLiveState", () => {
  it.each(["final", "incremental"] as const)(
    "retains rows and cursors for a pending host in %s publications",
    async (publication) => {
      const live = new SessionCatalogLiveState();
      const { progressId } = live.beginRequest(1);
      const current = catalog("codex", 2);
      current.hosts[0]!.nextCursor = "next-page";
      const pending = { ...current.hosts[0]!, pending: true, sessions: [], nextCursor: undefined };
      const incoming = { ...current, hosts: [pending] };
      const catalogs =
        publication === "final"
          ? live.mergeFinal([incoming], [current])
          : live.applyHost({
              payload: { progressId, agentId: "main", catalog: incoming },
              agentId: "main",
              catalogs: [current],
              pageDepths: new Map(),
            })!.catalogs;
      expect(catalogs[0]?.hosts[0]).toMatchObject({
        pending: true,
        sessions: current.hosts[0]!.sessions,
        nextCursor: "next-page",
      });
      // A final response still removes genuinely absent hosts.
      expect(catalogs[0]?.hosts).toHaveLength(publication === "final" ? 1 : 2);
      const request = vi.fn();
      expect(
        await refetchExpandedSessionCatalogPages({
          catalogs,
          previousCatalogs: [current],
          client: { request } as unknown as GatewayBrowserClient,
          agentId: "main",
          pageDepths: new Map([[sessionCatalogHostKey("codex", pending.hostId), 1]]),
          isCurrent: () => true,
          canRequestPage: () => true,
        }),
      ).toEqual(catalogs);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "fresh", details: {} },
    { name: "error", details: { error: { code: "UNAVAILABLE", message: "Node unavailable" } } },
    { name: "offline", details: { connected: false } },
  ])("clears pending when an expanded host publishes $name data", ({ details }) => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("codex", 1);
    current.hosts[0]!.pending = true;
    const { pending: _pending, ...fresh } = current.hosts[0]!;
    const result = live.applyHost({
      payload: {
        progressId,
        agentId: "main",
        catalog: { ...current, hosts: [{ ...fresh, ...details }] },
      },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map([[sessionCatalogHostKey("codex", fresh.hostId), 1]]),
    });
    expect(result?.catalogs[0]?.hosts[0]?.pending).toBeUndefined();
  });

  it("does not replace a settled progressive host with its pending final response", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("codex", 1);
    const pending: SessionCatalogHost = { ...current.hosts[0]!, pending: true, sessions: [] };
    const published = live.applyHost({
      payload: { progressId, agentId: "main", catalog: current },
      agentId: "main",
      catalogs: [{ ...current, hosts: [pending] }],
      pageDepths: new Map(),
    })!;
    expect(live.mergeFinal([{ ...current, hosts: [pending] }], published.catalogs)).toEqual([
      current,
    ]);
  });

  it("clears unavailable native readiness without losing another host or expanded rows", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("codex", 2);
    current.capabilities.startTerminal = true;
    current.hosts.forEach((host) => {
      host.canStartTerminal = true;
    });
    const changed = {
      ...current.hosts[0]!,
      canStartTerminal: false,
      sessions: [],
      error: { code: "offline", message: "Offline" },
    };
    const result = live.applyHost({
      payload: { progressId, agentId: "main", catalog: { ...current, hosts: [changed] } },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map([[sessionCatalogHostKey("codex", changed.hostId), 1]]),
    });
    expect(result?.catalogs[0]?.hosts.map((host) => host.canStartTerminal)).toEqual([false, true]);
    expect(result?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
    expect(result?.catalogs[0]?.hosts[0]?.sessions).toEqual(current.hosts[0]?.sessions);
  });
  it("compares a host event only with the catalog and host it can replace", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const changed = catalog("changed", 1);
    const unrelated = catalog("unrelated", 100);
    Object.defineProperty(unrelated, "toJSON", {
      value: () => {
        throw new Error("unrelated catalog serialized");
      },
    });

    let result: ReturnType<SessionCatalogLiveState["applyHost"]>;
    expect(() => {
      result = live.applyHost({
        payload: {
          progressId,
          agentId: "main",
          catalog: { ...changed, hosts: [changed.hosts[0]!] },
        },
        agentId: "main",
        catalogs: [changed, unrelated],
        pageDepths: new Map(),
      });
    }).not.toThrow();
    expect(result!).toBeNull();
  });

  it.each([
    {
      metadata: "capabilities",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        capabilities: {
          ...current.capabilities,
          createSession: { model: "openai/gpt-5.6-luna" },
        },
      }),
    },
    {
      metadata: "catalog error",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        error: { code: "unavailable", message: "Catalog temporarily unavailable" },
      }),
    },
  ])("applies $metadata from a progressive host event", ({ update }) => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("changed", 1);

    const result = live.applyHost({
      payload: {
        progressId,
        agentId: "main",
        catalog: { ...update(current), hosts: [current.hosts[0]!] },
      },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map(),
    });

    expect(result?.catalogs[0]).toEqual(update(current));
  });
});
