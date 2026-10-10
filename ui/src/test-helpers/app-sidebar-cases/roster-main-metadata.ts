import { describe, expect, it, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import {
  agentIds,
  mountRoster,
  owners,
  roster,
  selectFilter,
  session,
  sessionKeys,
} from "./roster.test-support.ts";

describe("AppSidebar main-chat metadata", () => {
  it("keeps main metadata and live PR snapshots on the header without an empty collapse control", async () => {
    const mainKey = "agent:working:main";
    const { sidebar, request, gatewayHarness } = await mountRoster(roster, [
      session("working", 10, {
        owner: { actor: owners[0] },
        worktree: { id: "wt-main", branch: "feature/header", repoRoot: "/repo" },
        icon: "home",
        visibility: "draft",
        hasActiveRun: true,
        status: "queued",
        unread: true,
      }),
    ]);
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation((method, ...args) =>
      method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD
        ? Promise.resolve({ subscribed: true })
        : originalRequest(method, ...args),
    );
    const hello = gatewayHarness.gateway.snapshot.hello!;
    gatewayHarness.publish({
      hello: {
        ...hello,
        features: {
          ...hello.features,
          methods: [...(hello.features?.methods ?? []), SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        },
      },
    });
    sidebar.storedOutboxes = {
      total: 2,
      attentionCountForSession: (key) => (key === mainKey ? 2 : 0),
      hasSessionDraft: (key) => key === mainKey,
    };
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        expect.anything(),
        expect.anything(),
      ),
    );
    const header = sidebar.querySelector(
      '[data-agent-group="working"] .sidebar-agent-roster__header',
    )!;
    // Subscription admission precedes the render that commits the main-row metadata.
    await vi.waitFor(() => {
      // Upstream #168575 makes the agent avatar the header’s only identity.
      expect(header.querySelector(".session-owner-chip")).toBeNull();
      expect(header.querySelector(".session-row-draft-indicator")).not.toBeNull();
      expect(header.querySelector(".session-row-badge--draft")).not.toBeNull();
      expect(header.querySelector('[aria-label="2 messages need attention"]')).not.toBeNull();
      expect(header.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(1);
      expect(header.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
      expect(header.querySelector("[data-agent-collapse]")).toBeNull();
      expect(sessionKeys(sidebar)).toEqual([]);
    });
    await sidebar.updateComplete;
    // These snapshots arrive while a different agent is selected. Header decoration
    // must watch Home itself, not depend on a duplicate main row or opening its chat.
    for (const state of ["open", "merged", null] as const) {
      gatewayHarness.publishEvent("controlUi.sessionPullRequests.changed", {
        sessions: {
          [mainKey]: {
            status: "ready",
            rateLimited: false,
            pullRequests: state
              ? [
                  {
                    number: 103,
                    owner: "openclaw",
                    repo: "openclaw",
                    branch: "feature/header",
                    title: "Header metadata",
                    url: "https://example.test/pull/103",
                    state,
                  },
                ]
              : [],
          },
        },
      });
      await vi.waitFor(() =>
        expect(
          header
            .querySelector("[data-pull-request-state]")
            ?.getAttribute("data-pull-request-state") ?? null,
        ).toBe(state),
      );
    }
    sidebar.storedOutboxes = {
      total: 0,
      attentionCountForSession: () => 0,
      hasSessionDraft: () => false,
    };
    await vi.waitFor(() => {
      expect(header.querySelector(".session-row-badge--draft")).toBeNull();
      expect(header.querySelector(".session-row-badge--attention")).toBeNull();
    });
  });

  it("filters main metadata by owner without removing agent navigation", async () => {
    const { sidebar } = await mountRoster(roster, [
      session("working", 10, {
        owner: { actor: owners[0] },
        incognito: true,
        hasActiveRun: true,
        status: "running",
        unread: true,
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    const header = sidebar.querySelector(
      '[data-agent-group="working"] .sidebar-agent-roster__header',
    )!;
    for (const [owner, visible] of [
      ["profile-sam", false],
      ["profile-ada", true],
      ["", true],
    ] as const) {
      await selectFilter(sidebar, `owner:${owner}`);
      await vi.waitFor(() => {
        expect(header.querySelector(".session-glyph__ring") !== null).toBe(visible);
        expect(header.querySelector(".session-row-badge--incognito") !== null).toBe(visible);
        expect(header.querySelector('[aria-label="Unread"]') !== null).toBe(visible);
      });
      expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
      expect(sessionKeys(sidebar)).toEqual([]);
    }
  });
});
