import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { createGatewayHarness, type SidebarLifecycleState } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { settleRoster } from "./roster.test-support.ts";
import {
  sessionFixture,
  human,
  sessionQuery,
  sessionList,
  expectAbsent,
} from "./session-suite.test-support.ts";

function expectEmptyLead(row: Element | null) {
  const lead = row?.querySelector(".sidebar-session-indicator");
  expect(lead).not.toBeNull();
  expect(lead?.childElementCount).toBe(0);
}

function ownedFixture(keys: string[]) {
  const fixture = sessionFixture(keys);
  for (const row of fixture.result.sessions) {
    row.createdActor = human("Ada");
    row.owner = { actor: row.createdActor };
  }
  fixture.result.owners = [human("Ada"), human("Bob")];
  return fixture;
}

function mockAvatarUrl(url: string) {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => url);
      static override revokeObjectURL = vi.fn();
    },
  );
}

async function publishChange(
  sessions: ReturnType<typeof sessionFixture>,
  sidebar: SidebarLifecycleState,
  change: Parameters<typeof reconcileSessionChanged>[1],
) {
  sessions.publish({
    result: reconcileSessionChanged(sessions.sessions.state.result, change).result,
  });
  await settleLitElement(sidebar);
}

describe("AppSidebar session indicators", () => {
  it("removes a session stripe when a changed event clears its color", async () => {
    const key = "agent:main:color";
    const sessions = sessionFixture([key]);
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const { sidebar } = await sessions.mount(gateway.gateway);
    const row = () => sessionQuery<HTMLElement>(sidebar, key);
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    await publishChange(sessions, sidebar, {
      sessionKey: key,
      color: "purple",
    });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-purple)");
    await publishChange(sessions, sidebar, {
      sessionKey: key,
      color: null,
    });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

  it("renders named glyphs and SVG artwork while keeping emoji as text", async () => {
    const glyphKey = "agent:main:glyph";
    const emojiKey = "agent:main:emoji";
    const svgKey = "agent:main:svg";
    const svgIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')}`;
    const sessions = sessionFixture([glyphKey, emojiKey, svgKey]);
    const glyph = sessions.row(glyphKey);
    const emoji = sessions.row(emojiKey);
    const svg = sessions.row(svgKey);
    glyph.icon = "braces";
    emoji.icon = "🦞";
    svg.icon = svgIcon;

    const { sidebar } = await sessions.mount();
    const glyphRow = sessionQuery(sidebar, glyphKey);
    const emojiRow = sessionQuery(sidebar, emojiKey);
    const svgRow = () => sessionQuery(sidebar, svgKey);

    expect(glyphRow?.querySelector(".session-glyph__icon svg")).not.toBeNull();
    expect(glyphRow?.querySelector(".session-glyph__emoji")).toBeNull();
    expect(emojiRow?.querySelector(".session-glyph__emoji")?.textContent).toBe("🦞");
    expect(emojiRow?.querySelector(".session-glyph__icon")).toBeNull();
    expect(svgRow()?.querySelector(".session-glyph__icon img")?.getAttribute("src")).toBe(svgIcon);
    expect(svgRow()?.querySelector(".session-glyph__icon svg")).toBeNull();
    expect(svgRow()?.querySelector(".session-glyph__emoji")).toBeNull();

    await publishChange(sessions, sidebar, {
      sessionKey: svgKey,
      icon: null,
    });
    expect(svgRow()?.querySelector(".session-glyph__icon")).toBeNull();
  });

  it("prioritizes session icons, then channel avatars, then owner chips", async () => {
    const iconKey = "agent:main:icon-wins";
    const avatarKey = "agent:main:channel-avatar";
    const ownerKey = "agent:main:owner-fallback";
    const sessions = ownedFixture([iconKey, avatarKey, ownerKey]);
    const result = sessions.result;
    for (const row of result.sessions) {
      if (row.key !== ownerKey) {
        row.channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(row.key)}`;
      }
    }
    const iconRow = sessions.row(iconKey);
    iconRow.icon = "🦞";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["avatar"], { type: "image/png" }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    mockAvatarUrl("blob:channel-avatar");
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.gateway.connection.token = "avatar-token";
    const { sidebar } = await sessions.mount(gatewayHarness.gateway);
    await waitForFast(() => {
      expect(sessionQuery(sidebar, avatarKey, ".channel-avatar")).not.toBeNull();
    });

    const icon = sessionQuery(sidebar, iconKey);
    expect(icon?.querySelector(".session-glyph__emoji")?.textContent).toBe("🦞");
    expectAbsent(icon, "openclaw-channel-avatar", ".session-owner-chip");

    const avatar = sessionQuery(sidebar, avatarKey);
    expect(avatar?.querySelector(".session-glyph--circular")).not.toBeNull();
    expect(avatar?.querySelector(".channel-avatar")?.getAttribute("src")).toBe(
      "blob:channel-avatar",
    );
    expect(
      avatar?.querySelector<HTMLElement>("openclaw-channel-avatar > span")?.style.display,
    ).toBe("none");

    const owner = sessionQuery(sidebar, ownerKey);
    expect(owner?.querySelector("openclaw-channel-avatar")).toBeNull();
    expect(owner?.querySelector(".session-owner-chip")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}`,
      {
        headers: { Authorization: "Bearer avatar-token" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("refetches a mounted channel avatar when its route revision changes", async () => {
    const avatarKey = "agent:main:avatar-revision";
    const missingUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}?v=old`;
    const restoredUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}?v=new`;
    const sessions = ownedFixture([avatarKey]);
    const row = sessions.row(avatarKey);
    row.channelAvatarUrl = missingUrl;

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("?v=old")) {
        return { ok: false, status: 404, blob: async () => new Blob([]) };
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["avatar"], { type: "image/png" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    mockAvatarUrl("blob:channel-avatar-restored");
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.gateway.connection.token = "avatar-token";
    const { sidebar } = await sessions.mount(gatewayHarness.gateway);
    // The pruned avatar 404s and its absence is cached under the old URL; the
    // owner chip must keep the lead slot occupied instead of an empty circle.
    await waitForFast(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const missingRow = sessionQuery(sidebar, avatarKey);
    expect(missingRow?.querySelector(".channel-avatar")).toBeNull();
    await waitForFast(() => {
      expect(missingRow?.querySelector(".session-owner-chip")).not.toBeNull();
    });

    // A restored/replaced backing image arrives as a new route revision; the
    // mounted row must fetch the new URL instead of reusing the sticky 404.
    await publishChange(sessions, sidebar, {
      sessionKey: avatarKey,
      channelAvatarUrl: restoredUrl,
    });

    await waitForFast(() => {
      expect(sessionQuery(sidebar, avatarKey, ".channel-avatar")?.getAttribute("src")).toBe(
        "blob:channel-avatar-restored",
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      restoredUrl,
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );
    // Once the avatar renders, the chip fallback yields to the real image.
    expect(
      sessionQuery<HTMLElement>(sidebar, avatarKey, "openclaw-channel-avatar > span")?.style
        .display,
    ).toBe("none");
  });

  it("keeps the owner chip when avatar auth is not ready", async () => {
    const avatarKey = "agent:main:avatar-auth-pending";
    const sessions = ownedFixture([avatarKey]);
    const row = sessions.row(avatarKey);
    row.channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}`;

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // No handshake and no token/password: the loader must not fetch, and the
    // row must show the owner chip rather than an empty circle.
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const pendingSnapshot = gatewayHarness.gateway.snapshot as { hello: unknown };
    pendingSnapshot.hello = null;
    const { sidebar } = await sessions.mount(gatewayHarness.gateway);
    const pendingRow = sessionQuery(sidebar, avatarKey);
    expect(pendingRow?.querySelector("openclaw-channel-avatar")).not.toBeNull();
    expect(pendingRow?.querySelector(".channel-avatar")).toBeNull();
    await waitForFast(() => {
      expect(pendingRow?.querySelector(".session-owner-chip")).not.toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents main-session running activity once around the agent avatar", async () => {
    const mainKey = "agent:main:main";
    const workingKey = "agent:main:working";
    const sessions = sessionFixture([mainKey, workingKey]);
    const result = sessions.result;
    for (const row of result.sessions) {
      row.hasActiveRun = true;
      row.status = "running";
      if (row.key === mainKey) {
        row.unread = true;
      }
    }
    const { sidebar } = await sessions.mount(undefined, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = workingKey;
    sidebar.storedOutboxes = {
      total: 2,
      attentionCountForSession: (sessionKey) => (sessionKey === mainKey ? 2 : 0),
      hasSessionDraft: (sessionKey) => sessionKey === mainKey,
    };
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    const home = sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__header');
    const homeRing = home?.querySelector(
      ".sidebar-agent-roster__avatar .session-glyph--running .session-glyph__ring",
    );
    expect(home?.querySelector(".sidebar-agent-roster__avatar")).not.toBeNull();
    expect(homeRing).not.toBeNull();
    expect(home?.querySelectorAll(".session-run-spinner")).toHaveLength(0);
    expect(home?.querySelectorAll('[aria-label="Unread"]')).toHaveLength(0);
    const activityLabel = "Active run";
    expect(homeRing?.getAttribute("aria-label")).toBe(activityLabel);
    expect(homeRing?.classList.contains("session-glyph__ring--queued")).toBe(false);
    expect(
      home?.querySelectorAll(`.session-glyph__ring[aria-label="${activityLabel}"]`),
    ).toHaveLength(1);
    expect(home?.querySelector(".session-row-badge--attention")).toBeNull();
    expect(home?.querySelector(".session-row-badge--draft")).toBeNull();
  });

  it("preserves child PR indicators and leads a pinned child like any other", async () => {
    const parentKey = "agent:main:parent";
    const pinnedKey = "agent:main:pinned-child";
    const runningKey = "agent:main:running-child";
    const queuedKey = "agent:main:queued-child";
    const openPullRequestKey = "agent:main:open-pr-child";
    const mergedPullRequestKey = "agent:main:merged-pr-child";
    const sessions = sessionFixture([parentKey]);
    const child = (key: string, label: string, overrides: Partial<GatewaySessionRow>) => ({
      key,
      label,
      spawnedBy: parentKey,
      kind: "direct" as const,
      updatedAt: 2,
      ...overrides,
    });
    sessions.list.mockResolvedValue(
      sessionList([
        child(pinnedKey, "Pinned child", {
          pinned: true,
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-pinned", branch: "feature/pinned", repoRoot: "/repo" },
        }),
        child(runningKey, "Running child", {
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-running", branch: "feature/running", repoRoot: "/repo" },
        }),
        child(queuedKey, "Queued child", {
          hasActiveRun: true,
          hasActiveSubagentRun: true,
          status: "queued",
        }),
        child(openPullRequestKey, "Open PR child", {
          hasActiveRun: true,
          status: "queued",
          unread: true,
          agentStatus: {
            note: "Waiting for input",
            attention: "key",
            expiresAt: Date.now() + 60_000,
          },
          worktree: { id: "wt-open", branch: "feature/open", repoRoot: "/repo" },
        }),
        child(mergedPullRequestKey, "Merged PR child", {
          worktree: { id: "wt-merged", branch: "feature/merged", repoRoot: "/repo" },
        }),
      ]),
    );
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await sessions.mount(gatewayHarness.gateway);
    sessions.publishList({
      result: sessionList([
        {
          key: parentKey,
          kind: "direct",
          label: "Parent",
          updatedAt: 1,
          childSessions: [
            pinnedKey,
            runningKey,
            queuedKey,
            openPullRequestKey,
            mergedPullRequestKey,
          ],
        },
      ]),
    });
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(4),
    );
    sidebar.querySelector<HTMLButtonElement>("[data-show-more-children]")?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(5),
    );
    sessions.sessions.setPullRequestSummary(openPullRequestKey, { numbers: [1], state: "open" });
    sessions.sessions.setPullRequestSummary(mergedPullRequestKey, {
      numbers: [2],
      state: "merged",
    });
    sidebar.invalidate();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(
        sessionQuery(sidebar, openPullRequestKey, '[data-pull-request-state="open"]'),
      ).not.toBeNull();
      expect(
        sessionQuery(sidebar, mergedPullRequestKey, '[data-pull-request-state="merged"]'),
      ).not.toBeNull();
    });
    // Pinning is not a status: a pinned child must lead exactly like an
    // unpinned child in the same run/unread state.
    const pinnedRow = sessionQuery(sidebar, pinnedKey);
    const runningRow = sessionQuery(sidebar, runningKey);
    const pinnedLead = pinnedRow?.querySelector(".sidebar-session-indicator");
    const runningLead = runningRow?.querySelector(".sidebar-session-indicator");
    expect(pinnedLead).not.toBeNull();
    expect(pinnedLead?.innerHTML).toBe(runningLead?.innerHTML);
    expect(pinnedLead?.querySelector("[data-pull-request-state]")).toBeNull();
    expect(pinnedRow?.querySelector(".session-row-state")).toBeNull();

    for (const [key, label] of [
      [pinnedKey, "Active run"],
      [runningKey, "Active run"],
      [queuedKey, "Queued"],
    ] as const) {
      const ring = sessionQuery(
        sidebar,
        key,
        ".sidebar-session-indicator .session-glyph--running .session-glyph__ring",
      );
      expect.soft(ring).not.toBeNull();
      expect.soft(ring?.getAttribute("aria-label")).toBe(label);
      expect.soft(ring?.classList.contains("session-glyph__ring--queued")).toBe(label === "Queued");
    }
    expect(
      sidebar.querySelectorAll(
        ".sidebar-recent-session .sidebar-session-indicator .session-run-spinner",
      ),
    ).toHaveLength(0);

    const attentionLead = sessionQuery(sidebar, openPullRequestKey, ".sidebar-session-indicator");
    expect(attentionLead?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    expect(attentionLead?.querySelector(".session-glyph__ring")).not.toBeNull();
    expect(
      attentionLead?.querySelector(".session-glyph__ring--queued")?.getAttribute("aria-label"),
    ).toBe("Queued");
    expectAbsent(attentionLead, ".session-glyph__badge--unread", "[data-pull-request-state]");
    const attentionLink = sessionQuery(
      sidebar,
      openPullRequestKey,
      ".sidebar-recent-session__link",
    );
    const attentionDescriptionId = attentionLink?.getAttribute("aria-describedby");
    expect(attentionDescriptionId).toBe(
      `sidebar-session-state-${encodeURIComponent(openPullRequestKey)}`,
    );
    expect(sidebar.querySelector(`[id="${attentionDescriptionId}"]`)?.textContent).toBe("Unread");
  });

  it("prioritizes an active run over unread activity", async () => {
    const keys = {
      plain: "agent:main:plain",
      forked: "agent:main:forked",
      unread: "agent:main:unread",
      runningUnread: "agent:main:status-running-unread",
      openPullRequest: "agent:main:open-pr",
      mergedPullRequest: "agent:main:merged-pr",
    };
    const sessions = sessionFixture(Object.values(keys));
    const result = sessions.result;
    for (const row of result.sessions) {
      if (row.key === keys.forked) {
        row.forkSource = { sessionKey: "agent:main:main", sessionId: "source-session" };
      } else if (row.key === keys.unread) {
        row.unread = true;
      } else if (row.key === keys.runningUnread) {
        row.status = "running";
        row.unread = true;
      } else if (row.key === keys.openPullRequest || row.key === keys.mergedPullRequest) {
        row.worktree = {
          id: `wt-${row.key}`,
          branch: row.key.endsWith("open-pr") ? "feature/open" : "feature/merged",
          repoRoot: "/repo",
        };
      }
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await sessions.mount(gatewayHarness.gateway);
    sidebar.connected = true;
    await sidebar.updateComplete;
    sessions.sessions.setPullRequestSummary(keys.openPullRequest, { numbers: [1], state: "open" });
    sessions.sessions.setPullRequestSummary(keys.mergedPullRequest, {
      numbers: [1],
      state: "merged",
    });

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-pull-request-state="merged"]')).not.toBeNull();
    });
    // Opening chat hydrates its detailed summary from the same last-known snapshot.
    // It must not add a second PR icon beside the sidebar's existing indicator.
    sessions.sessions.setPullRequestSummary(keys.openPullRequest, { numbers: [1], state: "open" });
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(
        `[data-session-key="${keys.openPullRequest}"] :is([data-session-pr-state], [data-pull-request-state])`,
      ),
    ).toHaveLength(1);
    const plain = sessionQuery(sidebar, keys.plain);
    expectEmptyLead(plain);
    expect(plain?.querySelector(".session-row-state")).toBeNull();

    const forked = sessionQuery(sidebar, keys.forked);
    expectEmptyLead(forked);
    const forkIndicator = forked?.querySelector(
      ".sidebar-recent-session__name .sidebar-session-fork-indicator",
    );
    expect(forkIndicator).not.toBeNull();
    expect(forkIndicator?.getAttribute("aria-label")).toBe("Forked session");
    expect(forkIndicator?.hasAttribute("title")).toBe(false);
    expect(forked?.querySelector(".session-row-state")).toBeNull();

    const unread = sessionQuery(sidebar, keys.unread);
    expect(unread?.querySelector(".sidebar-session-indicator .session-unread-dot")).not.toBeNull();
    expect(unread?.querySelector(".session-row-state")).toBeNull();
    expect(unread?.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);

    const runningUnread = sessionQuery(sidebar, keys.runningUnread);
    expect(runningUnread?.classList.contains("session-row-host--running")).toBe(true);
    expect(
      runningUnread?.querySelector(".sidebar-session-indicator .session-glyph__ring"),
    ).not.toBeNull();
    expectAbsent(
      runningUnread,
      ".session-row-state",
      ".session-unread-dot",
      ".session-glyph__badge--unread",
    );

    for (const key of [keys.forked, keys.runningUnread]) {
      const link = sessionQuery(sidebar, key, "a");
      const descriptionId = link?.getAttribute("aria-describedby");
      expect(descriptionId).toBe(`sidebar-session-state-${encodeURIComponent(key)}`);
      expect(sidebar.querySelector(`[id="${descriptionId}"]`)).not.toBeNull();
    }
    for (const row of [forked, unread, runningUnread]) {
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
    }
    expect(runningUnread?.querySelector(".sr-only")?.textContent).toBe("Unread");

    const openPullRequestIcon = sessionQuery(
      sidebar,
      keys.openPullRequest,
      '[data-pull-request-state="open"] svg',
    );
    const mergedPullRequestIcon = sessionQuery(
      sidebar,
      keys.mergedPullRequest,
      '[data-pull-request-state="merged"] svg',
    );
    expect(openPullRequestIcon).not.toBeNull();
    expect(mergedPullRequestIcon).not.toBeNull();
    expect(openPullRequestIcon?.isEqualNode(mergedPullRequestIcon ?? null)).toBe(false);

    for (const key of [keys.openPullRequest, keys.mergedPullRequest]) {
      const row = sessionQuery(sidebar, key);
      expectEmptyLead(row);
      expect(row?.querySelector(".session-row-badges [data-pull-request-state]")).not.toBeNull();
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
      expect(row?.querySelector("[data-pull-request-state]")?.hasAttribute("title")).toBe(false);
    }

    const openPullRequestRow = sessions.row(keys.openPullRequest);
    sessions.sessions.setPullRequestSummary(keys.openPullRequest, undefined);
    openPullRequestRow.worktree = undefined;
    sessions.publishList({ result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).toBeNull();
      expectEmptyLead(sessionQuery(sidebar, keys.openPullRequest));
    });
  });
});
