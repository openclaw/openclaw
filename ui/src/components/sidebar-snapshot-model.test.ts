import { expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  RowVisibilityReason,
  rowDemandsVisibility,
  visibleSessionChildren,
} from "./app-sidebar-session-types.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSections,
  snapshotSessions,
  snapshotIssuesCount,
} from "./sidebar-snapshot-model.ts";
import { sidebarSnapshot as model } from "./sidebar-snapshot.test-support.ts";

function captureRoster(rows: Parameters<typeof sessionsResult>[0]) {
  return captureBootRoster({
    result: sessionsResult(rows, 1),
    agentId: "main",
    groups: [],
    groupSettings: [],
    sectionOrder: [],
    loading: false,
    error: null,
  });
}
function displayRow(key: string, label: string, pinned = false) {
  return restoreSnapshotSession(
    { key, label, pinned, isChild: false, children: [] },
    pinned ? key : "",
  );
}
const parse = (patch: Record<string, unknown>) => parseSidebarSnapshot({ ...model, ...patch });

it("loads saved rows and cards that predate the optional display expansion", () => {
  // This is the stored shape admitted by the pre-expansion schema, without new fields.
  const legacy = {
    ...model,
    pinnedSessions: [
      {
        key: "agent:main:older",
        label: "Existing conversation",
        pinned: true,
        isChild: false,
        children: [],
        state: { unread: true, isRunVisuallyActive: true },
      },
    ],
    cards: [{ id: "main", name: "Harbor", mainKey: "agent:main:main" }],
  };
  const saved = parseSidebarSnapshot(structuredClone(legacy));
  expect(saved).not.toBeNull();
  expect(saved?.personalGroups).toBeUndefined();
  expect(saved?.cards).toEqual(legacy.cards);
  expect(restoreSnapshotSession(saved!.pinnedSessions[0]!, "")).toMatchObject({
    label: "Existing conversation",
    unread: true,
    isRunVisuallyActive: true,
    hasActiveRun: false,
    pinnable: false,
  });
});

it("omits private session contributions from the saved Inbox count", () => {
  const incognito = "agent:main:dashboard:incognito-private";
  const outbox: SidebarInboxEntry = {
    type: "outbox",
    category: "system",
    severity: "warning",
    dismissal: null,
    requiresAction: true,
    id: "public",
    sessionKey: "agent:main:public",
    held: true,
    command: false,
  };
  const approval: SidebarInboxEntry = {
    type: "approval",
    category: "approvals",
    severity: "warning",
    dismissal: null,
    requiresAction: true,
    approval: {
      id: "approval",
      kind: "exec",
      request: { command: "synthetic", sessionKey: incognito },
      createdAtMs: 0,
      expiresAtMs: 1,
    },
  };
  expect(
    snapshotIssuesCount([
      outbox,
      { ...outbox, id: "private", sessionKey: incognito },
      approval,
      {
        ...approval,
        approval: {
          ...approval.approval,
          request: { command: "synthetic", sessionKey: "agent:main:parent" },
          sourceSessionKey: incognito,
        },
      },
      {
        type: "mention",
        category: "mentions",
        severity: "neutral",
        dismissal: null,
        requiresAction: true,
        mention: { ...inboxMention("private"), sessionKey: incognito },
      },
      { ...outbox, id: "quiet", requiresAction: false },
    ]),
  ).toBe(1);
});

it("roundtrips hidden-run child queries without retaining incognito parent keys", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const child = displayRow("agent:main:child", "Child");
  const hiddenRun = "agent:main:subagent:review";
  const incognitoRun = "agent:main:subagent:incognito-private";
  const captured = snapshotSessions([
    { ...parent, children: [child], childLoadParentKeys: [parent.key, hiddenRun, incognitoRun] },
  ]);
  expect(captured[0]?.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  const saved = parseSidebarSnapshot(structuredClone({ ...model, pinnedSessions: captured }));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!.pinnedSessions[0]!, parent.key);
  expect(restored.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  expect(restored.children.map((row) => row.key)).toEqual([child.key]);
  const legacyParent = { ...captured[0], childLoadParentKeys: undefined };
  expect(parseSidebarSnapshot({ ...model, pinnedSessions: [legacyParent] })).toBeNull();
  expect(
    parseSidebarSnapshot({ ...model, pinnedSessions: [{ ...legacyParent, children: [] }] }),
  ).not.toBeNull();
  expect(
    parseSidebarSnapshot({
      ...model,
      pinnedSessions: [{ ...captured[0], childLoadParentKeys: [parent.key, incognitoRun] }],
    }),
  ).toBeNull();
});

it("keeps primary routing and header facts in the display snapshot without private or live authority", () => {
  const stable = {
    key: "agent:main:dashboard:cedar",
    kind: "direct" as const,
    displayName: "Cedar",
    boardFace: "dashboard" as const,
    boardPresentation: "expanded" as const,
    workspaceDir: "/synthetic/workspace",
  };
  const roster = captureRoster([
    { ...stable, sharingRole: "owner", hasActiveRun: true, activeModel: "stale-model" },
    { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
  ]);
  const saved = parse({ roster });
  expect(saved?.roster?.result.sessions).toEqual([stable]);
  expect(
    parseSidebarSnapshot({
      ...saved,
      roster: { ...roster, result: sessionsResult([{ ...stable, incognito: true }], 1) },
    }),
  ).toBeNull();
});

it("admits the sidebar after the live roster grows beyond the boot window", () => {
  const sessions = Array.from({ length: 240 }, (_, index) => ({
    key: `agent:main:session-${index}`,
    kind: "direct" as const,
    label: `Session ${index}`,
  }));
  const saved = parse({ roster: captureRoster(sessions) });
  expect(saved?.roster?.result.sessions).toEqual(sessions.slice(0, 200));
});

it("keeps display data without persisting authority, executable plugins, or watched sessions", () => {
  const plugin = { key: "reports/main", pluginId: "reports", id: "main", label: "Reports" };
  const card = { id: "main", name: "Harbor", mainKey: "agent:main:main" };
  const admitted = parseSidebarSnapshot({
    ...model,
    token: "synthetic-secret",
    footer: { ...model.footer, scopes: ["operator.admin"] },
    plugins: [{ ...plugin, mount() {} }],
    cards: [{ ...card, activeNow: true, assistantPreview: "Public reply", lastActiveAt: 99 }],
  });
  expect(admitted?.footer).toEqual(model.footer);
  expect(admitted?.plugins).toEqual([plugin]);
  expect(admitted?.cards).toEqual([{ ...card, activeNow: true, assistantPreview: "Public reply" }]);
  expect(admitted).not.toHaveProperty("token");
  expect(
    parse({ onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }] }),
  ).toBeNull();
});

it("excludes incognito roots and descendants and restores no live mutation facts", () => {
  const row = displayRow("agent:main:visible", "Project", true);
  const privateRow = { ...row, key: "agent:main:private", incognito: true };
  const publicChild = { ...row, key: "agent:main:child", children: [] };
  const captured = snapshotSessions(
    [
      {
        ...row,
        children: [privateRow, publicChild],
        sharingRole: "owner",
        activeRunIds: ["live-run"],
      },
      privateRow,
    ],
    (current) => ({
      childrenDisplayMode: "expanded",
      snapshotSubtitle:
        current.key === row.key ? { subtitle: "Private child approval details" } : undefined,
    }),
  );
  expect(captured).toHaveLength(1);
  expect(captured[0]?.children.map((child) => child.key)).toEqual([publicChild.key]);
  expect(captured[0]?.childrenDisplayMode).toBe("expanded");
  expect(captured[0]?.snapshotSubtitle).toBeUndefined();
  const restored = restoreSnapshotSession(captured[0]!, row.key);
  expect(restored).toMatchObject({ visuallyActive: true, pinnable: false });
  expect([restored.sharingRole, restored.activeRunIds]).toEqual([undefined, undefined]);
});

it("restores visible unread, activity and glyph facts without retaining attention text or run authority", () => {
  const row = {
    ...displayRow("agent:main:visible", "Project"),
    unread: true,
    hasActiveRun: true,
    hasAutomation: true,
    attention: {
      kind: "agent",
      icon: "key",
      note: "Private status text",
      sourceSessionKey: "another-session",
    } as const,
    ownAttention: { kind: "none" } as const,
    runningChildCount: 2,
  };
  const [saved] = snapshotSessions([row]);
  const parsed = parseSidebarSnapshot({ ...model, pinnedSessions: [saved] });
  expect(parsed).not.toBeNull();
  const restored = restoreSnapshotSession(parsed!.pinnedSessions[0]!, row.key);
  expect(restored).toMatchObject({
    unread: true,
    hasAutomation: true,
    isRunVisuallyActive: true,
    runningChildCount: 2,
    hasActiveRun: false,
    attention: { kind: "agent", icon: "key", note: "" },
    ownAttention: { kind: "none" },
  });
  expect(JSON.stringify(parsed)).not.toMatch(/Private status text|another-session/);
  expect(
    parseSidebarSnapshot({
      ...model,
      pinnedSessions: [{ ...saved, state: { attention: { kind: "agent" } } }],
    }),
  ).toBeNull();
});

it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
  const visible = displayRow("agent:main:public", "Public");
  const hidden = { ...visible, key: "agent:main:private", incognito: true };
  type Section = Parameters<typeof snapshotSections>[0][number];
  const section = (
    id: Section["id"],
    rows: Section["rows"],
    extra: Partial<Section> = {},
  ): Section => ({
    id,
    rows,
    totalRowCount: rows.length,
    visibleRowCount: rows.length,
    visibleLimit: 10,
    collapsedVisibleRowCount: rows.length,
    renderHeader: true,
    ...extra,
  });
  const sections = [
    section("project:private-path", [hidden], {
      project: { name: "Private project", path: "/private/project" },
    }),
    section("person:private-person", [hidden], {
      personOwner: { type: "human", id: "private-person", label: "Private person" },
    }),
    section("category:shared", [visible, hidden], { category: "Shared" }),
    section("category:empty", [], { category: "Empty" }),
  ];
  const captured = snapshotSections(
    sections,
    new Set([...sections.map(({ id }) => id), "online", "pinned", "category:gone"]),
  );
  const serialized = JSON.stringify(captured);
  const admitted = parse(JSON.parse(serialized));
  expect(admitted?.sections.map(({ id }) => id)).toEqual(["category:shared", "category:empty"]);
  expect(admitted?.sections[0]).toMatchObject({
    totalRowCount: 1,
    visibleRowCount: 1,
    collapsedVisibleRowCount: 1,
  });
  expect(admitted?.sections[1]?.totalRowCount).toBe(0);
  expect(admitted?.collapsedSections).toEqual([
    "category:shared",
    "category:empty",
    "online",
    "pinned",
  ]);
  expect(JSON.stringify(admitted)).not.toContain("private");
});

it("keeps Person-section artwork and every protocol display identity namespace", () => {
  for (const identity of [
    { type: "profile", id: "riley" },
    { type: "agent", id: "main" },
    { type: "remote", pluginId: "example", domain: "team", idKind: "user", id: "member" },
    { type: "observation", pluginId: null, accountId: null, senderKind: "human", id: "member" },
    { type: "legacy", actorType: "human", source: null, id: "member" },
  ]) {
    const owner = {
      type: "agent",
      id: "main",
      label: "Field Notes",
      avatarUrl: "/api/users/riley/avatar?v=1",
      identity,
    };
    const saved = parse({
      sections: [
        {
          id: "person:main",
          personOwner: owner,
          rows: [],
          totalRowCount: 0,
          visibleRowCount: 0,
          visibleLimit: 10,
          collapsedVisibleRowCount: 0,
          renderHeader: true,
        },
      ],
    });
    expect(saved?.sections[0]?.personOwner).toEqual(owner);
  }
});

it("retains row artwork and display badges without restoring mutation or run authority", () => {
  const actor = {
    type: "human" as const,
    id: "riley",
    label: "Riley",
    avatarUrl: "/api/users/riley/avatar?v=1",
    identity: { type: "profile" as const, id: "riley" },
  };
  const row = {
    ...displayRow("agent:main:visible", "Project"),
    owner: { actor, assignedAt: 1 },
    participants: [{ identity: { type: "agent" as const, id: "main" }, label: "Field Notes" }],
    participantCount: 1,
    visibility: "draft" as const,
    draftOwnedBySelf: true,
    titlePending: true,
    channelAvatarUrl: "/api/channel-avatar/example",
    channelPresentation: { channel: "example", channelLabel: "Example" },
    forkSource: { sessionId: "source", sessionKey: "agent:main:parent" },
    childSessionKeys: ["agent:main:child"],
    workspaceConflictCount: 2,
    hasComposerDraft: true,
    outboxAttentionCount: 1,
    snoozedUntil: 1000,
    hasActiveRun: true,
  };
  const [captured] = snapshotSessions([row]);
  const saved = parse({ pinnedSessions: [captured] });
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!.pinnedSessions[0]!, row.key);
  for (const key of [
    "owner",
    "participants",
    "participantCount",
    "visibility",
    "draftOwnedBySelf",
    "titlePending",
    "channelAvatarUrl",
    "channelPresentation",
    "workspaceConflictCount",
    "hasComposerDraft",
    "outboxAttentionCount",
    "snoozedUntil",
  ] as const) {
    expect(restored[key], key).toEqual(row[key]);
  }
  expect(restored.forkSource).toBeUndefined();
  expect(restored.snapshot).toMatchObject({ forked: true, childCount: 1 });
  expect(restored).toMatchObject({
    hasActiveRun: false,
    pinnable: false,
    cloudWorkerStopAction: null,
    modelSelectionLocked: true,
  });
});

it("keeps saved running children beyond the quiet-child cap without admitting a run", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const children = Array.from({ length: 6 }, (_, i) => ({
    ...displayRow("agent:main:child-" + i, "Child " + i),
    hasActiveRun: i === 5,
  }));
  const [saved] = snapshotSessions([
    {
      ...parent,
      childSessionKeys: children.map((c) => c.key),
      childLoadParentKeys: [parent.key],
      children,
    },
  ]);
  const restored = restoreSnapshotSession(saved!, "");
  expect(
    visibleSessionChildren({ session: restored, fullyShown: false }).map((c) => c.key),
  ).toContain(children[5]!.key);
  expect(rowDemandsVisibility(restored.children[5]!, RowVisibilityReason.ActiveRun)).toBe(true);
  expect(restored.children.every((c) => !c.hasActiveRun)).toBe(true);
});
