// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import {
  findCatalogSessionHovercardRow,
  formatSidebarTimestamp,
  projectSidebarSessionCatalogs,
} from "./app-sidebar-session-catalogs.ts";

const session = (
  threadId: string,
  overrides: Partial<SessionCatalogSession> = {},
): SessionCatalogSession => ({
  threadId,
  name: threadId,
  status: "idle",
  archived: false,
  canContinue: true,
  canArchive: false,
  ...overrides,
});
const host = (sessions: SessionCatalogSession[]): SessionCatalogHost => ({
  hostId: "gateway:codex",
  label: "Local Codex",
  kind: "gateway",
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
  it.each([
    [-10_000, "now"],
    [-5 * 60_000, "5m"],
  ] as const)("formats offset %i as %s", (offset, expected) => {
    expect(formatSidebarTimestamp(Date.now() + offset)).toBe(expected);
  });
  it("preserves direction for future timestamps", () => {
    expect(formatSidebarTimestamp(Date.now() + 30_000)).toBe("in 30s");
    expect(formatSidebarTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });
});

it("preserves adopted naming while distinguishing repository and workspace context", () => {
  const source = catalog([
    host([
      session("project", {
        name: "Renamed upstream",
        sessionKey: "agent:main:adopted-project",
        cwd: "/work/openclaw",
        gitBranch: "feature/hovercard",
      }),
      session("colored", { color: "cyan" }),
      session("workspace", { cwd: "/work/release-notes" }),
      session("pull-request", {
        cwd: "/work/pull-request",
        pullRequest: { numbers: [125068], state: "open" },
      }),
    ]),
  ]);
  type LiveRow = Parameters<typeof findCatalogSessionHovercardRow>[0]["liveRow"];
  const find = (id: string, liveRow?: LiveRow) =>
    findCatalogSessionHovercardRow({
      catalogs: [source],
      sessionKey: id.startsWith("agent:") ? id : "catalog:codex:gateway%3Acodex:" + id,
      liveRow,
    });
  const live = { label: "Project", hasAutomation: false, hasActiveRun: false };
  expect(find("colored")).toMatchObject({ color: "cyan", hasActiveRun: false });
  // An adopted session's cleared color overrides stale CLI metadata.
  expect(find("colored", live)?.color).toBeUndefined();
  expect(find("colored", { ...live, color: "red" })?.color).toBe("red");
  expect(
    find("agent:main:adopted-project", {
      ...live,
      label: "Operator chosen label",
      hasActiveRun: true,
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
  expect(find("workspace")?.workContext).toEqual({
    kind: "workspace",
    name: "release-notes",
    path: "/work/release-notes",
  });
  expect(find("pull-request")?.workContext).toEqual({
    kind: "project",
    name: "pull-request",
    path: "/work/pull-request",
  });
});

it.each([
  ["active", ["native"]],
  ["all", ["native", "adopted"]],
] as const)("applies shared %s visibility to adopted rows only", (statusFilter, expected) => {
  const row: GatewaySessionRow = { key: "agent:main:adopted", kind: "direct", snoozedUntil: 200 };
  const local = host([session("native"), session("adopted", { sessionKey: row.key })]);
  const visibility = projectSidebarArchiveVisibility({
    sessionData: {
      childSessionRowsByParent: {},
      loadedChildSessionKeys: new Set(),
      loadingChildSessionKeys: new Set(),
      childSessionErrorsByParent: new Map(),
    },
    sourceRows: [],
    selectedAgentId: "main",
    statusFilter,
    now: 100,
    deletionState: () => undefined,
    archiveVisibility: () => undefined,
  });
  const projected = projectSidebarSessionCatalogs(
    [catalog([local])],
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
});

it.each([false, true])(
  "filters by effective owner, preferring live adopted ownership (adopted=%s)",
  (adopted) => {
    const key = "agent:main:adopted";
    const hosts = [
      host(
        adopted
          ? [
              session("adopted", {
                sessionKey: key,
                createdActor: { id: "operator:creator", type: "human" },
              }),
            ]
          : ["mine", "theirs"].map((id) =>
              session(id, { createdActor: { id: "operator:" + id, type: "human" } }),
            ),
      ),
    ];
    const ownerId = adopted ? "operator:owner" : "operator:mine";
    const liveRows: GatewaySessionRow[] = adopted
      ? [{ key, kind: "direct", updatedAt: 1, owner: { actor: { type: "human", id: ownerId } } }]
      : [];
    expect(projectSidebarSessionCatalogs([catalog(hosts)], ownerId, liveRows)).toEqual([
      { ...catalog(hosts), visibleHosts: [{ ...hosts[0]!, sessions: [hosts[0]!.sessions[0]!] }] },
    ]);
  },
);
