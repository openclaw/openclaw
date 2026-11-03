import { afterEach, beforeEach, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createSessionActivity } from "./session-activity-owner.ts";

export function sessionActivityListing(
  sessions: GatewaySessionRow[],
  overrides: Partial<SessionsListResult> = {},
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    sessions,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    ...overrides,
  };
}

export function useSessionActivityControllerFixture() {
  const active: GatewaySessionRow = {
    key: "agent:work:release",
    agentId: "work",
    sessionId: "release-session",
    kind: "direct",
    updatedAt: 100,
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["release-run"],
  };
  const listing = (sessions: GatewaySessionRow[]) =>
    sessionActivityListing(sessions, { ts: 100, totalCount: sessions.length, hasMore: false });
  const controllers = new Set<ReturnType<typeof createSessionActivity>>();
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    for (const controller of controllers) {
      controller.dispose();
    }
    controllers.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return {
    active,
    listing,
    setup(this: void) {
      const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
      const request = vi.spyOn(client, "request").mockResolvedValue(listing([active]));
      const publications: Array<readonly GatewaySessionRow[] | undefined> = [];
      const controller = createSessionActivity(() => {
        publications.push(controller.result?.sessions);
      });
      controllers.add(controller);
      return { client, request, controller, publications };
    },
  };
}
