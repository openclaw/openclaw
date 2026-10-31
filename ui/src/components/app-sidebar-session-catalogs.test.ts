// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
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
const catalog = (sessions: SessionCatalogSession[]): SessionCatalog => ({
  id: "codex",
  label: "Codex",
  capabilities: { continueSession: true, archive: false },
  hosts: [
    { hostId: "gateway:codex", label: "Local Codex", kind: "gateway", connected: true, sessions },
  ],
});

afterEach(() => vi.restoreAllMocks());
it.each([
  [-10_000, "now"],
  [-5 * 60_000, "5m"],
  [30_000, "in 30s"],
] as const)("formats sidebar timestamp offset %i as %s", (offset, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  expect(formatSidebarTimestamp(Date.now() + offset)).toBe(expected);
});

it.each<[Partial<SessionCatalogSession>, "project" | "workspace", { branch?: string }]>([
  [{ gitBranch: "feature/hovercard" }, "project", { branch: "feature/hovercard" }],
  [{}, "workspace", {}],
  [{ pullRequest: { numbers: [125068], state: "open" } }, "project", {}],
])("projects catalog work context %j", (metadata, kind, extra) => {
  const row = findCatalogSessionHovercardRow({
    catalogs: [catalog([session("thread", { cwd: "/work/openclaw", ...metadata })])],
    sessionKey: "catalog:codex:gateway%3Acodex:thread",
  });
  expect(row?.workContext).toEqual({ kind, name: "openclaw", path: "/work/openclaw", ...extra });
});

it("preserves adopted naming, activity and cleared color over catalog metadata", () => {
  const catalogs = [
    catalog([
      session("thread", {
        name: "Upstream name",
        color: "cyan",
        sessionKey: "agent:main:adopted",
      }),
    ]),
  ];
  const liveRow = { label: "Operator label", hasAutomation: false, hasActiveRun: true };
  const find = (live?: typeof liveRow & { color?: string }) =>
    findCatalogSessionHovercardRow({ catalogs, sessionKey: "agent:main:adopted", liveRow: live });
  expect(find()).toMatchObject({ color: "cyan", hasActiveRun: false });
  expect(find(liveRow)).toMatchObject({ ...liveRow, color: undefined });
  expect(find({ ...liveRow, color: "red" })?.color).toBe("red");
});

it.each([
  ["active", ["native"]],
  ["all", ["native", "adopted"]],
] as const)("applies shared %s visibility to adopted rows only", (statusFilter, expected) => {
  const row: GatewaySessionRow = { key: "agent:main:adopted", kind: "direct", snoozedUntil: 200 };
  const local = catalog([session("native"), session("adopted", { sessionKey: row.key })]);
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
  const projected = projectSidebarSessionCatalogs([local], null, [row], visibility.isSessionHidden);
  expect(
    projected.flatMap((entry) =>
      entry.visibleHosts.flatMap((visibleHost) =>
        visibleHost.sessions.map((threadRow) => threadRow.threadId),
      ),
    ),
  ).toEqual(expected);
});

it.each(["mine", "adopted"])("filters by effective %s owner", (id) => {
  const key = "agent:main:adopted";
  const source = catalog([
    ...["mine", "theirs"].map((ownerId) =>
      session(ownerId, { createdActor: { id: ownerId, type: "human" } }),
    ),
    session("adopted", { sessionKey: key, createdActor: { id: "creator", type: "human" } }),
  ]);
  const liveRows: GatewaySessionRow[] = [
    { key, kind: "direct", owner: { actor: { type: "human", id: "adopted" } } },
  ];
  const result = projectSidebarSessionCatalogs([source], id, liveRows);
  expect(result).toHaveLength(1);
  expect(result[0]!.visibleHosts).toHaveLength(1);
  expect(result[0]!.visibleHosts[0]!.sessions.map((row) => row.threadId)).toEqual([id]);
  expect(
    projectSidebarSessionCatalogs(
      [{ ...source, error: { code: "UNAVAILABLE", message: "Discovery failed" } }],
      "unrelated",
      liveRows,
    ),
  ).toEqual([]);
});
