// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import {
  findCatalogSessionHovercardRow,
  formatSidebarTimestamp,
  projectSidebarSessionCatalogs,
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

describe("projectSidebarSessionCatalogs", () => {
  const catalog = (hosts: SessionCatalogHost[]): SessionCatalog => ({
    id: "codex",
    label: "Codex",
    capabilities: { continueSession: true, archive: false },
    hosts,
  });
  const session = (threadId: string, name: string) => ({
    threadId,
    name,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: false,
  });

  it.each([
    ["active", 100, ["native"]],
    ["active", 200, ["native", "adopted"]],
    ["all", 100, ["native", "adopted"]],
  ] as const)(
    "applies shared %s visibility at %i to adopted rows only",
    (statusFilter, now, expected) => {
      const row: GatewaySessionRow = {
        key: "agent:main:adopted",
        kind: "direct",
        snoozedUntil: 200,
      };
      const hosts: SessionCatalogHost[] = [
        {
          hostId: "gateway:local",
          label: "Gateway",
          kind: "gateway",
          connected: true,
          sessions: [
            session("native", "Native"),
            { ...session("adopted", "Adopted"), sessionKey: row.key },
          ],
        },
      ];
      const visibility = projectSidebarArchiveVisibility({
        sessionData: {
          sessionsAgentId: "main",
          sessionsResult: null,
          sessionResultsByAgent: {},
          childSessionRowsByParent: {},
          loadedChildSessionKeys: new Set(),
          loadingChildSessionKeys: new Set(),
          childSessionErrorsByParent: new Map(),
        },
        selectedAgentId: "main",
        statusFilter,
        now,
        deletionState: () => undefined,
        archiveVisibility: () => undefined,
      });
      const projected = projectSidebarSessionCatalogs(
        [catalog(hosts)],
        null,
        [row],
        visibility.isSessionHidden,
      );
      expect(
        projected.flatMap((entry) =>
          entry.visibleHosts.flatMap((host) =>
            host.sessions.map((threadRow) => threadRow.threadId),
          ),
        ),
      ).toEqual(expected);
    },
  );

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

    expect(projectSidebarSessionCatalogs([catalog(hosts)], null, [])).toEqual([
      { ...catalog(hosts), visibleHosts: [hosts[0]] },
    ]);
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

    expect(projectSidebarSessionCatalogs([catalog(hosts)], "operator:mine", [])).toEqual([
      { ...catalog(hosts), visibleHosts: [{ ...hosts[0]!, sessions: [hosts[0]!.sessions[0]!] }] },
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
      projectSidebarSessionCatalogs([catalog(hosts)], "operator:owner", [
        {
          key: adoptedKey,
          kind: "direct",
          updatedAt: 1,
          owner: { actor: { type: "human", id: "operator:owner" } },
        },
      ]),
    ).toEqual([{ ...catalog(hosts), visibleHosts: hosts }]);
  });
});
