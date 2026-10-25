import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { createGatewayHarness, type SidebarLifecycleState } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { settleRoster } from "./roster.test-support.ts";
import { sessionFixture, sessionQuery, human, sessionList } from "./session-suite.test-support.ts";

const prHello = {
  auth: { role: "operator", scopes: ["operator.read"] },
  features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
} as ApplicationGatewaySnapshot["hello"];
const avatarUrl = (key: string) => `/__openclaw__/channel-avatar/${encodeURIComponent(key)}`;
const avatarResponse = (ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  blob: async () => new Blob(ok ? ["avatar"] : [], { type: "image/png" }),
});
function stubAvatarLoader(fetchMock: typeof fetch, blob: string) {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => blob);
      static override revokeObjectURL = vi.fn();
    },
  );
}
function avatarFixture(key: string, url = avatarUrl(key)) {
  const sessions = sessionFixture([key]);
  sessions.row(key, {
    channelAvatarUrl: url,
    createdActor: human("Ada"),
    owner: { actor: human("Ada") },
  });
  sessions.result.owners = [human("Ada"), human("Bob")];
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  return { sessions, gateway };
}
function rowDom(sidebar: ParentNode, key: string) {
  return domProbe(sessionQuery(sidebar, key)!);
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
function expectEmptyLead(row: Element | null) {
  expect(row?.querySelector(".sidebar-session-indicator")).toMatchObject({ childElementCount: 0 });
}

describe("AppSidebar session indicators", () => {
  it("removes a session stripe when a changed event clears its color", async () => {
    const key = "agent:main:color";
    const sessions = sessionFixture([key]);
    const { sidebar } = await sessions.mount();
    const row = () => sessionQuery<HTMLElement>(sidebar, key);
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    await publishChange(sessions, sidebar, { sessionKey: key, color: "purple" });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-purple)");
    await publishChange(sessions, sidebar, { sessionKey: key, color: null });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

  it("renders named glyphs and SVG artwork while keeping emoji as text", async () => {
    const keys = ["glyph", "emoji", "svg"].map((id) => `agent:main:${id}`);
    const [glyphKey, emojiKey, svgKey] = keys;
    const svgIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')}`;
    const sessions = sessionFixture(keys);
    sessions.row(glyphKey!, { icon: "braces" });
    sessions.row(emojiKey!, { icon: "🦞" });
    sessions.row(svgKey!, { icon: svgIcon });
    const { sidebar } = await sessions.mount();
    const glyph = rowDom(sidebar, glyphKey!);
    const emoji = rowDom(sidebar, emojiKey!);
    const svg = rowDom(sidebar, svgKey!);
    expect(glyph.present(".session-glyph__icon svg", ".session-glyph__emoji")).toEqual([
      true,
      false,
    ]);
    expect(emoji.text(".session-glyph__emoji")).toBe("🦞");
    expect(emoji.query(".session-glyph__icon")).toBeNull();
    expect(svg.attr(".session-glyph__icon img", "src")).toBe(svgIcon);
    expect(svg.present(".session-glyph__icon svg", ".session-glyph__emoji")).toEqual([
      false,
      false,
    ]);
    await publishChange(sessions, sidebar, { sessionKey: svgKey!, icon: null });
    expect(rowDom(sidebar, svgKey!).query(".session-glyph__icon")).toBeNull();
  });

  it("prioritizes session icons, then channel avatars, then owner chips", async () => {
    const iconKey = "agent:main:icon-wins";
    const avatarKey = "agent:main:channel-avatar";
    const ownerKey = "agent:main:owner-fallback";
    const { sessions, gateway } = avatarFixture(avatarKey);
    const extra = sessionFixture([iconKey, ownerKey]).result.sessions;
    for (const row of extra) {
      Object.assign(row, { createdActor: human("Ada"), owner: { actor: human("Ada") } });
    }
    Object.assign(extra[0]!, { channelAvatarUrl: avatarUrl(iconKey), icon: "🦞" });
    sessions.result.sessions.push(...extra);
    sessions.result.count = 3;
    const fetchMock = vi.fn().mockResolvedValue(avatarResponse());
    stubAvatarLoader(fetchMock, "blob:channel-avatar");
    gateway.gateway.connection.token = "avatar-token";
    const { sidebar } = await sessions.mount(gateway.gateway);
    const avatar = rowDom(sidebar, avatarKey);
    await waitForFast(() => expect(avatar.query(".channel-avatar")).not.toBeNull());
    const icon = rowDom(sidebar, iconKey);
    expect(icon.text(".session-glyph__emoji")).toBe("🦞");
    expect(icon.present("openclaw-channel-avatar", ".session-owner-chip")).toEqual([false, false]);
    expect(avatar.query(".session-glyph--circular")).not.toBeNull();
    expect(avatar.attr(".channel-avatar", "src")).toBe("blob:channel-avatar");
    expect(avatar.query<HTMLElement>("openclaw-channel-avatar > span")?.style.display).toBe("none");
    expect(
      rowDom(sidebar, ownerKey).present("openclaw-channel-avatar", ".session-owner-chip"),
    ).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledWith(avatarUrl(avatarKey), {
      headers: { Authorization: "Bearer avatar-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("refetches a mounted channel avatar when its route revision changes", async () => {
    const key = "agent:main:avatar-revision";
    const restoredUrl = `${avatarUrl(key)}?v=new`;
    const { sessions, gateway } = avatarFixture(key, `${avatarUrl(key)}?v=old`);
    const fetchMock = vi.fn(async (input: string | URL) =>
      avatarResponse(!String(input).endsWith("?v=old")),
    );
    stubAvatarLoader(fetchMock as unknown as typeof fetch, "blob:channel-avatar-restored");
    gateway.gateway.connection.token = "avatar-token";
    const { sidebar } = await sessions.mount(gateway.gateway);
    const dom = rowDom(sidebar, key);
    await waitForFast(() => expect(fetchMock).toHaveBeenCalled());
    expect(dom.query(".channel-avatar")).toBeNull();
    await waitForFast(() => expect(dom.query(".session-owner-chip")).not.toBeNull());
    await publishChange(sessions, sidebar, { sessionKey: key, channelAvatarUrl: restoredUrl });
    await waitForFast(() =>
      expect(dom.attr(".channel-avatar", "src")).toBe("blob:channel-avatar-restored"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      restoredUrl,
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );
    expect(dom.query<HTMLElement>("openclaw-channel-avatar > span")?.style.display).toBe("none");
  });

  it("keeps the owner chip when avatar auth is not ready", async () => {
    const key = "agent:main:avatar-auth-pending";
    const { sessions, gateway } = avatarFixture(key);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pendingSnapshot = gateway.gateway.snapshot as { hello: unknown };
    pendingSnapshot.hello = null;
    const { sidebar } = await sessions.mount(gateway.gateway);
    const dom = rowDom(sidebar, key);
    expect(dom.present("openclaw-channel-avatar", ".channel-avatar")).toEqual([true, false]);
    await waitForFast(() => expect(dom.query(".session-owner-chip")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents main-session running activity once around the agent avatar", async () => {
    const mainKey = "agent:main:main";
    const workingKey = "agent:main:working";
    const sessions = sessionFixture([mainKey, workingKey]);
    for (const row of sessions.result.sessions) {
      Object.assign(row, {
        hasActiveRun: true,
        status: "running",
        ...(row.key === mainKey ? { unread: true } : {}),
      });
    }
    const { sidebar } = await sessions.mount(undefined, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
    Object.assign(sidebar, {
      activeRouteId: "chat",
      sessionKey: workingKey,
      connected: true,
      sidebarAgentsMode: "roster",
      storedOutboxes: {
        total: 2,
        attentionCountForSession: (key: string) => (key === mainKey ? 2 : 0),
        hasSessionDraft: (key: string) => key === mainKey,
      },
    });
    await settleRoster(sidebar);
    const home = domProbe(
      sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__header')!,
    );
    const ring = home.query(
      ".sidebar-agent-roster__avatar .session-glyph--running .session-glyph__ring",
    );
    expect(home.query(".sidebar-agent-roster__avatar")).not.toBeNull();
    expect(ring?.getAttribute("aria-label")).toBe("Active run");
    expect(ring?.classList.contains("session-glyph__ring--queued")).toBe(false);
    expect(home.all('.session-glyph__ring[aria-label="Active run"]')).toHaveLength(1);
    expect(
      home.present(
        ".session-run-spinner",
        '[aria-label="Unread"]',
        ".session-row-badge--attention",
        ".session-row-badge--draft",
      ),
    ).toEqual([false, false, false, false]);
  });

  it("preserves child PR indicators and leads a pinned child like any other", async () => {
    const parentKey = "agent:main:parent";
    const [pinnedKey, runningKey, queuedKey, openKey, mergedKey] = [
      "pinned",
      "running",
      "queued",
      "open-pr",
      "merged-pr",
    ].map((id) => `agent:main:${id}-child`);
    const childKeys = [pinnedKey!, runningKey!, queuedKey!, openKey!, mergedKey!];
    const sessions = sessionFixture([parentKey]);
    const worktree = (id: string) => ({
      id: `wt-${id}`,
      branch: `feature/${id}`,
      repoRoot: "/repo",
    });
    const fields: Partial<GatewaySessionRow>[] = [
      {
        pinned: true,
        hasActiveRun: true,
        status: "running",
        unread: true,
        worktree: worktree("pinned"),
      },
      { hasActiveRun: true, status: "running", unread: true, worktree: worktree("running") },
      { hasActiveRun: true, hasActiveSubagentRun: true, status: "queued" },
      {
        hasActiveRun: true,
        status: "queued",
        unread: true,
        worktree: worktree("open"),
        agentStatus: {
          note: "Waiting for input",
          attention: "key",
          expiresAt: Date.now() + 60_000,
        },
      },
      { worktree: worktree("merged") },
    ];
    sessions.list.mockResolvedValue(
      sessionList(
        childKeys.map((key, index) => ({
          key,
          spawnedBy: parentKey,
          kind: "direct",
          label: key,
          createdAt: 5 - index,
          updatedAt: 2,
          ...fields[index],
        })),
      ),
    );
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ hello: prHello });
    const { sidebar } = await sessions.mount(gateway.gateway);
    sessions.publishList({
      result: sessionList([
        { key: parentKey, kind: "direct", label: "Parent", updatedAt: 1, childSessions: childKeys },
      ]),
    });
    await settleLitElement(sidebar);
    const dom = domProbe(sidebar);
    expect(dom.attr("[data-child-session-toggle]", "aria-expanded")).toBe("true");
    await waitForFast(() => expect(dom.all(".sidebar-recent-session--child")).toHaveLength(4));
    dom.query<HTMLButtonElement>("[data-show-more-children]")?.click();
    await waitForFast(() => expect(dom.all(".sidebar-recent-session--child")).toHaveLength(5));
    sessions.sessions.setPullRequestSummary(openKey!, { numbers: [1], state: "open" });
    sessions.sessions.setPullRequestSummary(mergedKey!, { numbers: [2], state: "merged" });
    sidebar.invalidate();
    await sidebar.updateComplete;
    await waitForFast(() => {
      expect(rowDom(sidebar, openKey!).query('[data-pull-request-state="open"]')).not.toBeNull();
      expect(
        rowDom(sidebar, mergedKey!).query('[data-pull-request-state="merged"]'),
      ).not.toBeNull();
    });
    const pinned = rowDom(sidebar, pinnedKey!);
    const pinnedLead = pinned.query(".sidebar-session-indicator");
    expect(pinnedLead).not.toBeNull();
    expect(pinnedLead?.innerHTML).toBe(
      rowDom(sidebar, runningKey!).query(".sidebar-session-indicator")?.innerHTML,
    );
    expect(pinnedLead?.querySelector("[data-pull-request-state]")).toBeNull();
    expect(pinned.query(".session-row-state")).toBeNull();
    for (const [key, label] of [
      [pinnedKey!, "Active run"],
      [runningKey!, "Active run"],
      [queuedKey!, "Queued"],
    ]) {
      const ring = rowDom(sidebar, key!).query(
        ".sidebar-session-indicator .session-glyph--running .session-glyph__ring",
      );
      expect.soft(ring).not.toBeNull();
      expect.soft(ring?.getAttribute("aria-label")).toBe(label);
      expect.soft(ring?.classList.contains("session-glyph__ring--queued")).toBe(label === "Queued");
    }
    expect(
      dom.all(".sidebar-recent-session .sidebar-session-indicator .session-run-spinner"),
    ).toHaveLength(0);
    const attention = domProbe(rowDom(sidebar, openKey!).query(".sidebar-session-indicator")!);
    expect(
      attention.present(
        '[data-session-attention="agent"]',
        ".session-glyph__ring",
        ".session-glyph__badge--unread",
        "[data-pull-request-state]",
      ),
    ).toEqual([true, true, false, false]);
    expect(attention.attr(".session-glyph__ring--queued", "aria-label")).toBe("Queued");
    const descriptionId = rowDom(sidebar, openKey!).attr(
      ".sidebar-recent-session__link",
      "aria-describedby",
    );
    expect(descriptionId).toBe(`sidebar-session-state-${encodeURIComponent(openKey!)}`);
    expect(dom.text(`[id="${descriptionId}"]`)).toBe("Unread");
  });

  it("prioritizes an active run over unread activity", async () => {
    const keys = Object.fromEntries(
      ["plain", "forked", "unread", "runningUnread", "openPullRequest", "mergedPullRequest"].map(
        (id) => [id, `agent:main:${id}`],
      ),
    );
    const sessions = sessionFixture(Object.values(keys));
    sessions.row(keys.forked!, {
      forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
    });
    sessions.row(keys.unread!, { unread: true });
    sessions.row(keys.runningUnread!, { status: "running", unread: true });
    for (const [key, branch] of [
      [keys.openPullRequest!, "feature/open"],
      [keys.mergedPullRequest!, "feature/merged"],
    ]) {
      sessions.row(key!, { worktree: { id: `wt-${key}`, branch: branch!, repoRoot: "/repo" } });
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({ hello: prHello });
    const { sidebar } = await sessions.mount(gateway.gateway);
    sidebar.connected = true;
    await sidebar.updateComplete;
    sessions.sessions.setPullRequestSummary(keys.openPullRequest!, { numbers: [1], state: "open" });
    sessions.sessions.setPullRequestSummary(keys.mergedPullRequest!, {
      numbers: [1],
      state: "merged",
    });
    const dom = domProbe(sidebar);
    await waitForFast(() => {
      expect(dom.query('[data-pull-request-state="open"]')).not.toBeNull();
      expect(dom.query('[data-pull-request-state="merged"]')).not.toBeNull();
    });
    sessions.sessions.setPullRequestSummary(keys.openPullRequest!, { numbers: [1], state: "open" });
    await sidebar.updateComplete;
    expect(
      rowDom(sidebar, keys.openPullRequest!).all(
        ":is([data-session-pr-state], [data-pull-request-state])",
      ),
    ).toHaveLength(1);
    const plain = sessionQuery(sidebar, keys.plain!);
    const forked = sessionQuery(sidebar, keys.forked!);
    expectEmptyLead(plain);
    expectEmptyLead(forked);
    expect(plain?.querySelector(".session-row-state")).toBeNull();
    const fork = rowDom(sidebar, keys.forked!).query(
      ".sidebar-recent-session__name .sidebar-session-fork-indicator",
    );
    expect(fork?.getAttribute("aria-label")).toBe("Forked session");
    expect(fork?.hasAttribute("title")).toBe(false);
    const unread = rowDom(sidebar, keys.unread!);
    expect(unread.query(".sidebar-session-indicator .session-unread-dot")).not.toBeNull();
    expect(unread.query("a")?.hasAttribute("aria-describedby")).toBe(false);
    const running = rowDom(sidebar, keys.runningUnread!);
    expect(
      sessionQuery(sidebar, keys.runningUnread!)?.classList.contains("session-row-host--running"),
    ).toBe(true);
    expect(running.query(".sidebar-session-indicator .session-glyph__ring")).not.toBeNull();
    expect(running.present(".session-unread-dot", ".session-glyph__badge--unread")).toEqual([
      false,
      false,
    ]);
    for (const key of [keys.forked!, keys.runningUnread!]) {
      const id = rowDom(sidebar, key).attr("a", "aria-describedby");
      expect(id).toBe(`sidebar-session-state-${encodeURIComponent(key)}`);
      expect(dom.query(`[id="${id}"]`)).not.toBeNull();
    }
    for (const key of [keys.forked!, keys.unread!, keys.runningUnread!]) {
      const row = rowDom(sidebar, key);
      expect(row.query(".session-row-state")).toBeNull();
      expect(row.query("a")?.hasAttribute("title")).toBe(false);
    }
    expect(running.text(".sr-only")).toBe("Unread");
    const prIcons = [keys.openPullRequest!, keys.mergedPullRequest!].map((key) =>
      rowDom(sidebar, key).query("[data-pull-request-state] svg"),
    );
    expect(prIcons[0]).not.toBeNull();
    expect(prIcons[1]).not.toBeNull();
    expect(prIcons[0]?.isEqualNode(prIcons[1] ?? null)).toBe(false);
    for (const key of [keys.openPullRequest!, keys.mergedPullRequest!]) {
      const row = rowDom(sidebar, key);
      expectEmptyLead(sessionQuery(sidebar, key));
      expect(row.query(".session-row-badges [data-pull-request-state]")).not.toBeNull();
      expect(row.query("a")?.hasAttribute("title")).toBe(false);
      expect(row.query("[data-pull-request-state]")?.hasAttribute("title")).toBe(false);
    }
    sessions.sessions.setPullRequestSummary(keys.openPullRequest!, undefined);
    sessions.row(keys.openPullRequest!, { worktree: undefined });
    sessions.publishList({ result: sessions.result });
    await waitForFast(() => {
      expect(dom.query('[data-pull-request-state="open"]')).toBeNull();
      expectEmptyLead(sessionQuery(sidebar, keys.openPullRequest!));
    });
  });
});
