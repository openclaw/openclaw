// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const session = (threadId: string, name: string) => ({
  threadId,
  name,
  status: "idle",
  archived: false,
  canContinue: true,
  canArchive: false,
});
const host = (sessions: SessionCatalogHost["sessions"], remote = false): SessionCatalogHost => ({
  hostId: remote ? "node:remote" : "gateway:codex",
  label: remote ? "Remote node" : "Local Codex",
  kind: remote ? "node" : "gateway",
  connected: true,
  sessions,
});
const catalog = (hosts: SessionCatalogHost[]): SessionCatalog => ({
  id: "codex",
  label: "Codex",
  capabilities: { continueSession: true, archive: false },
  hosts,
});

describe("formatSidebarTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("keeps the localized current-time label for recent sessions", () => {
    expect(formatSidebarTimestamp(Date.now() - 10_000)).toBe("now");
  });

  it("uses compact localized units for older sessions", () => {
    expect(formatSidebarTimestamp(Date.now() - 5 * 60_000)).toBe("5m");
  });

  it("preserves direction for timestamps in the future", () => {
    expect(formatSidebarTimestamp(Date.now() + 30_000)).toBe("in 30s");
    expect(formatSidebarTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });
});

describe("findCatalogSessionHovercardRow", () => {
  it("preserves adopted naming while distinguishing repository and workspace context", () => {
    const source = catalog([
      host([
        {
          ...session("project", "Renamed upstream"),
          sessionKey: "agent:main:adopted-project",
          cwd: "/work/openclaw",
          gitBranch: "feature/hovercard",
        },
        {
          ...session("colored", "Colored CLI session"),
          color: "cyan",
        },
        {
          ...session("workspace", "Workspace"),
          cwd: "/work/release-notes",
        },
        {
          ...session("pull-request", "Pull request"),
          cwd: "/work/pull-request",
          pullRequest: { numbers: [125068], state: "open" },
        },
      ]),
    ]);
    source.capabilities.archive = true;
    const find = (sessionKey: string) =>
      findCatalogSessionHovercardRow({ catalogs: [source], sessionKey });

    const colorInput = { catalogs: [source], sessionKey: "catalog:codex:gateway%3Acodex:colored" };
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
        catalogs: [source],
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
    expect(find("catalog:codex:gateway%3Acodex:workspace")?.workContext).toEqual({
      kind: "workspace",
      name: "release-notes",
      path: "/work/release-notes",
    });
    expect(find("catalog:codex:gateway%3Acodex:pull-request")?.workContext).toEqual({
      kind: "project",
      name: "pull-request",
      path: "/work/pull-request",
    });
  });
});

describe("projectSidebarSessionCatalogs", () => {
  it.each([
    ["active", 100, ["native"]],
    ["all", 100, ["native", "adopted"]],
  ] as const)(
    "applies shared %s visibility at %i to adopted rows only",
    (statusFilter, now, expected) => {
      const row: GatewaySessionRow = {
        key: "agent:main:adopted",
        kind: "direct",
        snoozedUntil: 200,
      };
      const hosts = [
        host([
          session("native", "Native"),
          { ...session("adopted", "Adopted"), sessionKey: row.key },
        ]),
      ];
      hosts[0]!.hostId = "gateway:local";
      hosts[0]!.label = "Gateway";
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
          entry.visibleHosts.flatMap((visibleHost) =>
            visibleHost.sessions.map((threadRow) => threadRow.threadId),
          ),
        ),
      ).toEqual(expected);
    },
  );

  it("filters sessions by effective owner without inferring host identity", () => {
    const hosts = [
      host(
        [
          {
            ...session("mine", "Mine"),
            createdActor: { id: "operator:mine", type: "human" },
          },
          {
            ...session("theirs", "Theirs"),
            createdActor: { id: "operator:theirs", type: "human" },
          },
        ],
        true,
      ),
    ];

    expect(projectSidebarSessionCatalogs([catalog(hosts)], "operator:mine", [])).toEqual([
      { ...catalog(hosts), visibleHosts: [{ ...hosts[0]!, sessions: [hosts[0]!.sessions[0]!] }] },
    ]);
  });

  it("uses a live adopted session owner before catalog creator provenance", () => {
    const adoptedKey = "agent:main:adopted";
    const hosts = [
      host(
        [
          {
            ...session("adopted", "Adopted"),
            sessionKey: adoptedKey,
            createdActor: { id: "operator:creator", type: "human" },
          },
        ],
        true,
      ),
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
