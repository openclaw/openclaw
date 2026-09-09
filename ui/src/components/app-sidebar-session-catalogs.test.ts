// @vitest-environment jsdom
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import { i18n } from "../i18n/index.ts";
import { renderSessionCatalogGroups } from "./app-sidebar-session-catalog-render.ts";
import {
  buildCatalogSessionMenuRequest,
  findCatalogSessionHovercardRow,
  formatSidebarTimestamp,
  visibleCatalogHosts,
  type CatalogBackingSessionDisplay,
} from "./app-sidebar-session-catalogs.ts";

describe("formatSidebarTimestamp", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("keeps the localized current-time label for recent sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 10_000)).toBe("now");
  });

  it("uses compact localized units for older sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 5 * 60_000)).toBe("5m");
  });

  it("preserves direction for timestamps in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() + 30_000)).toBe("in 30s");
    expect(formatSidebarTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });
});

describe("findCatalogSessionHovercardRow", () => {
  it("preserves adopted naming while distinguishing repository and workspace context", () => {
    const catalogSession = (threadId: string, name: string) => ({
      threadId,
      name,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: false,
    });
    const catalog: SessionCatalog = {
      id: "codex",
      label: "Codex",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:codex",
          label: "Local Codex",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              ...catalogSession("project", "Renamed upstream"),
              sessionKey: "agent:main:adopted-project",
              cwd: "/work/openclaw",
              gitBranch: "feature/hovercard",
            },
            {
              ...catalogSession("colored", "Colored CLI session"),
              color: "cyan",
            },
            {
              ...catalogSession("workspace", "Workspace"),
              cwd: "/work/release-notes",
            },
            {
              ...catalogSession("pull-request", "Pull request"),
              cwd: "/work/pull-request",
              pullRequest: { numbers: [125068], state: "open" },
            },
          ],
        },
      ],
    };

    const colorInput = { catalogs: [catalog], sessionKey: "catalog:codex:gateway%3Acodex:colored" };
    expect(findCatalogSessionHovercardRow(colorInput)).toMatchObject({
      color: "cyan",
      hasActiveRun: false,
    });
    // An adopted session's cleared color must not fall back to stale CLI metadata.
    expect(
      findCatalogSessionHovercardRow({
        ...colorInput,
        liveRow: { label: "Project", hasAutomation: false, hasActiveRun: false },
      })?.color,
    ).toBeUndefined();
    expect(
      findCatalogSessionHovercardRow({
        ...colorInput,
        liveRow: { label: "Project", color: "red", hasAutomation: false, hasActiveRun: false },
      })?.color,
    ).toBe("red");
    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "agent:main:adopted-project",
        liveRow: { label: "Operator chosen label", hasAutomation: false, hasActiveRun: true },
      }),
    ).toMatchObject({
      label: "Operator chosen label",
      hasActiveRun: true,
      workContext: {
        kind: "project",
        name: "openclaw",
        path: "/work/openclaw",
        branch: "feature/hovercard",
      },
    });
    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "catalog:codex:gateway%3Acodex:workspace",
      })?.workContext,
    ).toEqual({ kind: "workspace", name: "release-notes", path: "/work/release-notes" });
    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "catalog:codex:gateway%3Acodex:pull-request",
      })?.workContext,
    ).toEqual({ kind: "project", name: "pull-request", path: "/work/pull-request" });
  });
});

describe("buildCatalogSessionMenuRequest", () => {
  it("preserves native lifecycle capabilities for adopted catalog rows", () => {
    const session = {
      threadId: "thread-1",
      name: "Native session",
      status: "idle" as const,
      archived: false,
      canContinue: true,
      canArchive: false,
      canOpenTerminal: true,
    };
    const request = buildCatalogSessionMenuRequest({
      catalog: { capabilities: { continueSession: true, archive: true } },
      session,
      key: { catalogId: "codex", hostId: "gateway:local", threadId: session.threadId },
      agentId: "main",
      routeId: "chat",
      navigation: {},
      meta: "now",
    });

    expect(request).toMatchObject({
      canOpenTerminal: true,
      canDelete: false,
      name: "Native session",
      meta: "now",
    });
  });
});

describe("renderSessionCatalogGroups", () => {
  it("routes adopted rows through the native catalog menu", () => {
    const displays: CatalogBackingSessionDisplay[] = [];
    const sessionKey = "agent:main:adopted";
    const container = document.createElement("div");
    render(
      html`${renderSessionCatalogGroups({
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: true },
            hosts: [
              {
                hostId: "gateway:local",
                label: "Local Codex",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "thread-1",
                    sessionKey,
                    name: "Native session",
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                    canOpenTerminal: true,
                  },
                ],
              },
            ],
          },
        ],
        connected: true,
        basePath: "",
        routeSessionKey: "",
        newSessionAgentId: "main",
        mainKey: "agent:main:main",
        collapsedSections: new Set(),
        loadingMoreCatalogIds: new Set(),
        visibleSessionLimits: new Map(),
        projectGrouping: "none",
        liveRows: [
          { key: sessionKey, label: "OpenClaw row", hasAutomation: false, hasActiveRun: false },
        ],
        renderLiveRow: (_row: unknown, display: CatalogBackingSessionDisplay) => {
          displays.push(display);
          return null;
        },
        onToggleSection: () => {},
        draggingSectionId: null,
        sectionDropTarget: null,
        onSectionDragOver: () => {},
        onSectionDragLeave: () => {},
        onSectionDrop: () => {},
        onStartSectionDrag: () => {},
        onFinishSectionDrag: () => {},
        viewMenuOpenCatalogId: null,
        ownerFilterActive: false,
        onOpenViewMenu: () => {},
        onLoadMore: () => {},
        onSetVisibleSessionLimit: () => {},
        catalogOpenTarget: "viewer",
        terminalAvailable: true,
        onOpenTerminal: () => {},
        onOpenMenu: () => {},
        onCatalogMenuTriggerRendered: () => {},
        isMenuOpen: () => false,
      } as never)}`,
      container,
    );

    expect(displays[0]?.catalogMenu).toMatchObject({
      canOpenTerminal: true,
      canDelete: false,
    });
  });
});

describe("visibleCatalogHosts", () => {
  const session = (threadId: string, name: string) => ({
    threadId,
    name,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: false,
  });

  it("removes empty hosts", () => {
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "gateway:local",
        label: "Gateway",
        kind: "gateway",
        connected: true,
        sessions: [session("shared", "Gateway copy")],
      },
      {
        hostId: "node:empty",
        label: "Empty node",
        kind: "node",
        connected: true,
        sessions: [],
      },
    ];

    expect(visibleCatalogHosts(hosts)).toEqual([hosts[0]]);
  });

  it("filters sessions by effective owner without inferring host identity", () => {
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "node:remote",
        label: "Remote node",
        kind: "node",
        connected: true,
        sessions: [
          {
            ...session("mine", "Mine"),
            createdActor: { id: "operator:mine", type: "human" },
          },
          {
            ...session("theirs", "Theirs"),
            createdActor: { id: "operator:theirs", type: "human" },
          },
        ],
      },
    ];

    expect(visibleCatalogHosts(hosts, "operator:mine")).toEqual([
      { ...hosts[0]!, sessions: [hosts[0]!.sessions[0]!] },
    ]);
  });

  it("uses a live adopted session owner before catalog creator provenance", () => {
    const adoptedKey = "agent:main:adopted";
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "node:remote",
        label: "Remote node",
        kind: "node",
        connected: true,
        sessions: [
          {
            ...session("adopted", "Adopted"),
            sessionKey: adoptedKey,
            createdActor: { id: "operator:creator", type: "human" },
          },
        ],
      },
    ];

    expect(
      visibleCatalogHosts(hosts, "operator:owner", new Map([[adoptedKey, "operator:owner"]])),
    ).toEqual(hosts);
  });
});
