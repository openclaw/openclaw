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
import { sessionFixture, human, sessionList, expectAbsent } from "./session-suite.test-support.ts";

function expectEmptyLead(row: Element | null) {
  expect(row?.querySelector(".sidebar-session-indicator")).toMatchObject({ childElementCount: 0 });
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

function avatarResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(["avatar"], { type: "image/png" }) };
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
  key: string,
  patch: Partial<Record<"color" | "icon" | "channelAvatarUrl", string | null>>,
) {
  sessions.publish({
    result: reconcileSessionChanged(sessions.sessions.state.result, { sessionKey: key, ...patch })
      .result,
  });
  await settleLitElement(sidebar);
}

function iconFacts(row: Element | null) {
  expect(row).not.toBeNull();
  return {
    svg: row?.querySelector(".session-glyph__icon svg") !== null,
    icon: row?.querySelector(".session-glyph__icon") !== null,
    emoji: row?.querySelector(".session-glyph__emoji")?.textContent ?? null,
    image: row?.querySelector(".session-glyph__icon img")?.getAttribute("src") ?? null,
    channel: row?.querySelector("openclaw-channel-avatar") !== null,
    circular: row?.querySelector(".session-glyph--circular") !== null,
    avatar: row?.querySelector(".channel-avatar")?.getAttribute("src") ?? null,
    avatarPresent: row?.querySelector(".channel-avatar") !== null,
    fallback: row?.querySelector<HTMLElement>("openclaw-channel-avatar > span")?.style.display,
    owner: row?.querySelector(".session-owner-chip") !== null,
  };
}

function pullRequestGateway(client: GatewayBrowserClient = {} as GatewayBrowserClient) {
  const gateway = createGatewayHarness(client);
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return gateway;
}

async function mountAvatar(key: string, url: string, fetchMock: typeof fetch, blobUrl?: string) {
  const sessions = ownedFixture([key]);
  sessions.row(key).channelAvatarUrl = url;
  vi.stubGlobal("fetch", fetchMock);
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  if (blobUrl) {
    mockAvatarUrl(blobUrl);
    gateway.gateway.connection.token = "avatar-token";
  } else {
    const snapshot = gateway.gateway.snapshot as { hello: unknown };
    snapshot.hello = null;
  }
  return { sessions, ...(await sessions.mount(gateway.gateway)) };
}

describe("AppSidebar session indicators", () => {
  it("removes a session stripe when a changed event clears its color", async () => {
    const key = "agent:main:color";
    const sessions = sessionFixture([key]);
    const { sidebar, query } = await sessions.mount();
    const row = () => query<HTMLElement>(key);
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    await publishChange(sessions, sidebar, key, { color: "purple" });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-purple)");
    await publishChange(sessions, sidebar, key, { color: null });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

  it("renders named glyphs and SVG artwork while keeping emoji as text", async () => {
    const glyphKey = "agent:main:glyph";
    const emojiKey = "agent:main:emoji";
    const svgKey = "agent:main:svg";
    const svgIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')}`;
    const sessions = sessionFixture([glyphKey, emojiKey, svgKey]);
    sessions.row(glyphKey, { icon: "braces" });
    sessions.row(emojiKey, { icon: "🦞" });
    sessions.row(svgKey, { icon: svgIcon });

    const { sidebar, query } = await sessions.mount();
    expect(iconFacts(query(glyphKey))).toMatchObject({ svg: true, emoji: null });
    expect(iconFacts(query(emojiKey))).toMatchObject({ emoji: "🦞", icon: false });
    expect(iconFacts(query(svgKey))).toMatchObject({ image: svgIcon, svg: false, emoji: null });

    await publishChange(sessions, sidebar, svgKey, { icon: null });
    expect(iconFacts(query(svgKey))).toMatchObject({ icon: false });
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
    sessions.row(iconKey, { icon: "🦞" });
    const fetchMock = vi.fn().mockResolvedValue(avatarResponse());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    mockAvatarUrl("blob:channel-avatar");
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.gateway.connection.token = "avatar-token";
    const { query } = await sessions.mount(gatewayHarness.gateway);
    await waitForFast(() => expect(query(avatarKey, ".channel-avatar")).not.toBeNull());

    expect(iconFacts(query(iconKey))).toMatchObject({ emoji: "🦞", channel: false, owner: false });
    expect(iconFacts(query(avatarKey))).toMatchObject({
      circular: true,
      avatar: "blob:channel-avatar",
      fallback: "none",
    });
    expect(iconFacts(query(ownerKey))).toMatchObject({ channel: false, owner: true });
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
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("?v=old")) {
        return { ok: false, status: 404, blob: async () => new Blob([]) };
      }
      return avatarResponse();
    });
    const { sessions, sidebar, query } = await mountAvatar(
      avatarKey,
      missingUrl,
      fetchMock as unknown as typeof fetch,
      "blob:channel-avatar-restored",
    );
    await waitForFast(() => expect(fetchMock).toHaveBeenCalled());
    expect(iconFacts(query(avatarKey))).toMatchObject({ avatarPresent: false });
    await waitForFast(() => expect(iconFacts(query(avatarKey))).toMatchObject({ owner: true }));

    await publishChange(sessions, sidebar, avatarKey, { channelAvatarUrl: restoredUrl });

    await waitForFast(() =>
      expect(query(avatarKey, ".channel-avatar")?.getAttribute("src")).toBe(
        "blob:channel-avatar-restored",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      restoredUrl,
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );
    expect(iconFacts(query(avatarKey))).toMatchObject({ fallback: "none" });
  });

  it("keeps the owner chip when avatar auth is not ready", async () => {
    const avatarKey = "agent:main:avatar-auth-pending";
    const fetchMock = vi.fn();
    const { query } = await mountAvatar(
      avatarKey,
      `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}`,
      fetchMock as unknown as typeof fetch,
    );
    expect(iconFacts(query(avatarKey))).toMatchObject({ channel: true, avatarPresent: false });
    await waitForFast(() => expect(iconFacts(query(avatarKey))).toMatchObject({ owner: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents main-session running activity once around the agent avatar", async () => {
    const mainKey = "agent:main:main";
    const workingKey = "agent:main:working";
    const sessions = sessionFixture([mainKey, workingKey]);
    for (const row of sessions.result.sessions) {
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
    const pinned = "agent:main:pinned-child";
    const running = "agent:main:running-child";
    const queued = "agent:main:queued-child";
    const openPr = "agent:main:open-pr-child";
    const mergedPr = "agent:main:merged-pr-child";
    const sessions = sessionFixture([parentKey]);
    const child = (
      key: string,
      status?: "running" | "queued",
      branch?: string,
      overrides: Partial<GatewaySessionRow> = {},
    ): GatewaySessionRow => ({
      key,
      spawnedBy: parentKey,
      kind: "direct",
      updatedAt: 2,
      ...(status ? { status, hasActiveRun: true } : {}),
      ...(status === "running" ? { unread: true } : {}),
      ...(branch
        ? { worktree: { id: `wt-${branch}`, branch: `feature/${branch}`, repoRoot: "/repo" } }
        : {}),
      ...overrides,
    });
    sessions.list.mockResolvedValue(
      sessionList([
        child(pinned, "running", "pinned", { pinned: true }),
        child(running, "running", "running"),
        child(queued, "queued", undefined, { hasActiveSubagentRun: true }),
        child(openPr, "queued", "open", {
          unread: true,
          agentStatus: {
            note: "Waiting for input",
            attention: "key",
            expiresAt: Date.now() + 60_000,
          },
        }),
        child(mergedPr, undefined, "merged"),
      ]),
    );
    const gatewayHarness = pullRequestGateway();
    const { sidebar, query } = await sessions.mount(gatewayHarness.gateway);
    const capability = sessions.sessions;
    sessions.publishList({
      result: sessionList([
        {
          key: parentKey,
          kind: "direct",
          updatedAt: 1,
          childSessions: [pinned, running, queued, openPr, mergedPr],
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
    capability.setPullRequestSummary(openPr, { numbers: [1], state: "open" });
    capability.setPullRequestSummary(mergedPr, {
      numbers: [2],
      state: "merged",
    });
    sidebar.invalidate();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(query(openPr, '[data-pull-request-state="open"]')).not.toBeNull();
      expect(query(mergedPr, '[data-pull-request-state="merged"]')).not.toBeNull();
    });
    const pinnedRow = query(pinned);
    const runningRow = query(running);
    const pinnedLead = pinnedRow?.querySelector(".sidebar-session-indicator");
    const runningLead = runningRow?.querySelector(".sidebar-session-indicator");
    expect(pinnedLead).not.toBeNull();
    expect(pinnedLead?.innerHTML).toBe(runningLead?.innerHTML);
    expect(pinnedLead?.querySelector("[data-pull-request-state]")).toBeNull();
    expect(pinnedRow?.querySelector(".session-row-state")).toBeNull();

    for (const [key, label] of [
      [pinned, "Active run"],
      [running, "Active run"],
      [queued, "Queued"],
    ] as const) {
      const ring = query(
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

    const attentionLead = query(openPr, ".sidebar-session-indicator");
    expect(attentionLead?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    expect(attentionLead?.querySelector(".session-glyph__ring")).not.toBeNull();
    expect(
      attentionLead?.querySelector(".session-glyph__ring--queued")?.getAttribute("aria-label"),
    ).toBe("Queued");
    expectAbsent(attentionLead, ".session-glyph__badge--unread", "[data-pull-request-state]");
    const attentionLink = query(openPr, ".sidebar-recent-session__link");
    const attentionDescriptionId = attentionLink?.getAttribute("aria-describedby");
    expect(attentionDescriptionId).toBe(`sidebar-session-state-${encodeURIComponent(openPr)}`);
    expect(sidebar.querySelector(`[id="${attentionDescriptionId}"]`)?.textContent).toBe("Unread");
  });

  it("prioritizes an active run over unread activity", async () => {
    const keys = {
      plain: "agent:main:plain",
      forked: "agent:main:forked",
      unread: "agent:main:unread",
      runningUnread: "agent:main:status-running-unread",
      openPr: "agent:main:open-pr",
      mergedPr: "agent:main:merged-pr",
    };
    const sessions = sessionFixture(Object.values(keys));
    sessions.row(keys.forked).forkSource = {
      sessionKey: "agent:main:main",
      sessionId: "source-session",
    };
    sessions.row(keys.unread).unread = true;
    Object.assign(sessions.row(keys.runningUnread), { status: "running", unread: true });
    for (const key of [keys.openPr, keys.mergedPr]) {
      sessions.row(key).worktree = {
        id: `wt-${key}`,
        branch: key.endsWith("open-pr") ? "feature/open" : "feature/merged",
        repoRoot: "/repo",
      };
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gatewayHarness = pullRequestGateway({ request } as unknown as GatewayBrowserClient);
    const { sidebar, query } = await sessions.mount(gatewayHarness.gateway);
    const capability = sessions.sessions;
    sidebar.connected = true;
    await sidebar.updateComplete;
    capability.setPullRequestSummary(keys.openPr, { numbers: [1], state: "open" });
    capability.setPullRequestSummary(keys.mergedPr, {
      numbers: [1],
      state: "merged",
    });

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-pull-request-state="merged"]')).not.toBeNull();
    });
    // Hydrating chat must not duplicate the sidebar PR indicator.
    capability.setPullRequestSummary(keys.openPr, { numbers: [1], state: "open" });
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(
        `[data-session-key="${keys.openPr}"] :is([data-session-pr-state], [data-pull-request-state])`,
      ),
    ).toHaveLength(1);
    const plain = query(keys.plain);
    expectEmptyLead(plain);
    expect(plain?.querySelector(".session-row-state")).toBeNull();

    const forked = query(keys.forked);
    expectEmptyLead(forked);
    const forkIndicator = forked?.querySelector(
      ".sidebar-recent-session__name .sidebar-session-fork-indicator",
    );
    expect(forkIndicator).not.toBeNull();
    expect(forkIndicator?.getAttribute("aria-label")).toBe("Forked session");
    expect(forkIndicator?.hasAttribute("title")).toBe(false);
    expect(forked?.querySelector(".session-row-state")).toBeNull();

    const unread = query(keys.unread);
    expect(unread?.querySelector(".sidebar-session-indicator .session-unread-dot")).not.toBeNull();
    expect(unread?.querySelector(".session-row-state")).toBeNull();
    expect(unread?.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);

    const runningUnread = query(keys.runningUnread);
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
      const link = query(key, "a");
      const descriptionId = link?.getAttribute("aria-describedby");
      expect(descriptionId).toBe(`sidebar-session-state-${encodeURIComponent(key)}`);
      expect(sidebar.querySelector(`[id="${descriptionId}"]`)).not.toBeNull();
    }
    for (const row of [forked, unread, runningUnread]) {
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
    }
    expect(runningUnread?.querySelector(".sr-only")?.textContent).toBe("Unread");

    const openPrIcon = query(keys.openPr, '[data-pull-request-state="open"] svg');
    const mergedPrIcon = query(keys.mergedPr, '[data-pull-request-state="merged"] svg');
    expect(openPrIcon).not.toBeNull();
    expect(mergedPrIcon).not.toBeNull();
    expect(openPrIcon?.isEqualNode(mergedPrIcon ?? null)).toBe(false);

    for (const key of [keys.openPr, keys.mergedPr]) {
      const row = query(key);
      expectEmptyLead(row);
      expect(row?.querySelector(".session-row-badges [data-pull-request-state]")).not.toBeNull();
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
      expect(row?.querySelector("[data-pull-request-state]")?.hasAttribute("title")).toBe(false);
    }

    const openPrRow = sessions.row(keys.openPr);
    capability.setPullRequestSummary(keys.openPr, undefined);
    openPrRow.worktree = undefined;
    sessions.publishList({ result: sessions.result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).toBeNull();
      expectEmptyLead(query(keys.openPr));
    });
  });
});
