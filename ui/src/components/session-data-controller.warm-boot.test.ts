/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { SessionsListResult } from "../api/types.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import type { BootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import * as snapshotPrewarm from "../pages/chat/session-snapshot-prewarm.ts";
import { createContext, createGatewayHarness, TWO_AGENTS } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";
import { SessionDataController } from "./session-data-controller.ts";

afterEach(() => vi.restoreAllMocks());

describe("sidebar live roster publication", () => {
  it.each([
    { name: "before controller binding", cacheTiming: "before", profileId: null, filtered: false },
    { name: "after controller binding", cacheTiming: "after", profileId: null, filtered: false },
    {
      name: "before a different profile connects",
      cacheTiming: "after",
      profileId: "other-profile",
      filtered: false,
    },
    {
      name: "before filtered live rows win bootstrap",
      cacheTiming: "after",
      profileId: null,
      filtered: true,
    },
  ] as const)(
    "leaves routing cache loaded $name to its owner and renders only live rows",
    async ({ cacheTiming, profileId, filtered }) => {
      const cached = sessionsResult(
        [
          {
            key: "agent:main:kept",
            sessionId: "kept-session",
            kind: "direct",
            updatedAt: 1,
            derivedTitle: "Cached title",
            lastMessagePreview: "Cached preview",
          },
          { key: "agent:main:deleted", kind: "direct", updatedAt: 1 },
        ],
        1,
      );
      const live = sessionsResult(
        [{ key: "agent:main:kept", sessionId: "kept-session", kind: "direct", updatedAt: 2 }],
        2,
      );
      const archived = sessionsResult(
        [{ key: "agent:main:archived", kind: "direct", updatedAt: 2, archived: true }],
        2,
      );
      const firstList = createDeferred<SessionsListResult>();
      const reconnectList = createDeferred<SessionsListResult>();
      const responses = [firstList, reconnectList];
      const request = vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          if (params && typeof params === "object" && "archived" in params) {
            return archived;
          }
          const response = responses.shift();
          if (!response) {
            throw new Error("Unexpected extra session list");
          }
          return response.promise;
        }
        if (method === "sessions.groups.list") {
          return { names: [], groups: [], sectionOrder: [] };
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        throw new Error(`Unexpected Gateway request: ${method}`);
      });
      const gateway = createGatewayHarness(createTestGatewayClient(request));
      gateway.publish({ phase: "connecting", hello: null });
      const cachedRoster = createDeferred<BootRoster | null>();
      vi.spyOn(snapshotPrewarm, "readSidebarBootSnapshot").mockImplementation(async () => {
        const roster = await cachedRoster.promise;
        return roster ? sidebarBootSnapshot(roster) : null;
      });
      const sessions = createSessionCapability(
        gateway.gateway,
        { state: { selectedId: "main" }, subscribe: () => () => undefined },
        {
          bootRecord: {
            version: 2,
            authMethod: "token",
            credential: "9d17676d",
            recoveryScope: "synthetic-account",
            scope: gatewayCredentialScope(gateway.gateway.connection.gatewayUrl),
            savedAt: Date.now(),
            profileId: null,
            agents: TWO_AGENTS,
            groups: [],
            sectionOrder: [],
          },
        },
      );
      const context = createContext(gateway.gateway, sessions, TWO_AGENTS);
      let statusFilter: "active" | "archived" = "active";
      const host = {
        isConnected: true,
        get connected() {
          return gateway.gateway.snapshot.phase === "connected";
        },
        activeRouteId: "sessions",
        getRouteSessionKey: () => context.gateway.snapshot.sessionKey.trim(),
        sessionDataContext: context,
        addController: () => undefined,
        removeController: () => undefined,
        requestUpdate: () => undefined,
        updateComplete: Promise.resolve(true),
        dismissTransientMenus: () => false,
        expandedAgentId: () => "main",
        promoteCreatedSession: () => undefined,
        selectedAgentIdForSessions: () => "main",
        sidebarSessionStatusFilter: () => statusFilter,
        sidebarSessionOwnerFilter: () => ({ ownerId: null, involvingMe: false }),
        sessionCatalogIdsWithoutVisibleRows: () => [],
        querySelector: () => null,
      } satisfies SessionDataControllerHost;
      const controller = new SessionDataController(host);
      try {
        if (cacheTiming === "after") {
          controller.hostConnected();
        }
        cachedRoster.resolve({
          agentId: "main",
          result: cached,
          groups: [],
          groupSettings: [],
          sectionOrder: [],
        });
        await sessions.whenCachedRosterSettled();
        if (cacheTiming === "before") {
          controller.hostConnected();
        }

        expect(sessions.canonicalListRevision).toBe(0);
        expect(sessions.state.resultCached).toBe(true);
        expect(controller.sessionsResult).toBeNull();
        expect(controller.sessionsAgentId).toBeNull();
        expect(request).not.toHaveBeenCalled();

        if (filtered) {
          statusFilter = "archived";
          controller.resetSessionList();
        }
        gateway.publish({ phase: "connected", selfUser: profileId ? { id: profileId } : null });
        if (profileId) {
          expect(sessions.state.result).toBeNull();
          expect(controller.sessionsResult).toBeNull();
          expect(controller.sessionResultsByAgent).toEqual({});
        }
        if (filtered) {
          await controller.refreshSidebarSessions();
          expect(controller.sessionsResult?.sessions).toEqual(archived.sessions);
        }
        firstList.resolve(live);
        await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(1));
        expect(sessions.state.resultCached).toBe(false);
        expect(controller.sessionResultsByAgent.main?.sessions).toEqual(
          filtered ? archived.sessions : live.sessions,
        );
        if (filtered) {
          expect(controller.sessionsResult?.sessions).toEqual(archived.sessions);
          statusFilter = "active";
          controller.resetSessionList();
        }
        expect(controller.sessionsResult?.sessions).toEqual(live.sessions);

        gateway.publish({ phase: "reconnecting" });
        expect(controller.sessionsResult?.sessions).toEqual(live.sessions);
        gateway.publish({ phase: "connected" });
        sessions.reconcile(
          { key: "agent:main:partial", sessionId: "partial-session", kind: "direct", updatedAt: 3 },
          live.defaults,
        );
        expect(sessions.canonicalListRevision).toBe(1);
        expect(controller.sessionsResult?.sessions).toEqual(live.sessions);

        const refreshed = sessionsResult(
          [{ key: "agent:main:replacement", kind: "direct", updatedAt: 4 }],
          4,
        );
        reconnectList.resolve(refreshed);
        await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(2));
        expect(controller.sessionsResult?.sessions).toEqual(refreshed.sessions);
      } finally {
        controller.hostDisconnected();
        sessions.dispose();
      }
    },
  );
});
