import { afterEach, beforeEach, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

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
  const listing = (sessions: GatewaySessionRow[]): SessionsListResult => ({
    ts: 100,
    path: "",
    count: sessions.length,
    totalCount: sessions.length,
    hasMore: false,
    sessions,
    defaults: { model: null, modelProvider: null, contextTokens: null },
  });
  const controllers = new Set<SessionActivityController>();
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    for (const controller of controllers) {
      controller.hostDisconnected();
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
      const controller = new SessionActivityController({
        addController() {},
        removeController() {},
        requestUpdate() {
          publications.push(controller.result?.sessions);
        },
        updateComplete: Promise.resolve(true),
      });
      controllers.add(controller);
      return { client, request, controller, publications };
    },
  };
}
