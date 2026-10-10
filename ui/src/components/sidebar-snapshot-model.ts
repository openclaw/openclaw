import { z } from "zod";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

const text = z.string();
const optionalText = text.optional();
const user = z.object({
  id: text,
  name: optionalText,
  email: optionalText,
  avatarUrl: optionalText,
  identity: z.object({ type: z.literal("profile"), id: text }).optional(),
});
const sessionFields = z.object({
  key: text.refine((key) => !isIncognitoSessionKey(key)),
  label: text,
  agentId: optionalText,
  subtitle: optionalText,
  snapshotSubtitle: z
    .object({ subtitle: optionalText, narration: optionalText, toolName: optionalText })
    .optional(),
  childrenDisplayMode: z.enum(["collapsed-by-user", "expanded", "expanded-fully"]).optional(),
  icon: optionalText,
  color: optionalText,
  pinned: z.boolean(),
  archived: z.boolean().optional(),
  isChild: z.boolean(),
  category: optionalText,
  boardFace: z.enum(["chat", "dashboard"]).optional(),
  incognito: z.literal(false).optional(),
});
export type SidebarSnapshotSession = z.infer<typeof sessionFields> & {
  children: SidebarSnapshotSession[];
};
const session: z.ZodType<SidebarSnapshotSession> = sessionFields.extend({
  children: z.lazy(() => session.array()),
});
const sectionId = z.custom<SidebarSessionSection<unknown>["id"]>(
  (value) =>
    typeof value === "string" &&
    /^(agent:|category:|person:|project:|catalog:|pinned$|ungrouped$|groups$|work$)/.test(value),
);
export const sidebarSnapshotSchema = z.object({
  mode: z.enum(["chip", "roster"]),
  entries: text
    .refine(
      (entry) =>
        !entry.startsWith("session:") || !isIncognitoSessionKey(entry.slice("session:".length)),
    )
    .array(),
  sessions: session.array(),
  sections: z
    .object({
      id: sectionId,
      category: optionalText,
      personOwner: z
        .object({
          type: z.enum(["human", "agent", "system"]),
          id: text,
          label: optionalText,
          identity: z.object({ type: z.literal("profile"), id: text }).optional(),
        })
        .optional(),
      project: z.object({ name: text, path: text }).optional(),
      groups: z.boolean().optional(),
      work: z.boolean().optional(),
      rows: session.array(),
      totalRowCount: z.number(),
      visibleRowCount: z.number(),
      visibleLimit: z.number(),
      collapsedVisibleRowCount: z.number(),
      renderHeader: z.boolean(),
    })
    .array(),
  cards: z
    .object({
      id: text,
      name: text,
      mainKey: text,
      avatar: text.nullable().optional(),
      textAvatar: text.nullable().optional(),
      role: optionalText,
      model: optionalText,
    })
    .array(),
  collapsedAgentIds: text.array(),
  collapsedSections: text.array(),
  plugins: z
    .object({
      key: text,
      pluginId: text,
      id: text,
      label: text,
      icon: optionalText,
      placement: optionalText,
      path: optionalText,
      slug: optionalText,
    })
    .array(),
  onlineUsers: user
    .extend({
      watchedSessions: z.array(text).max(0),
      entries: z
        .array(z.object({ ts: z.number(), lastActivityAt: z.number().optional() }))
        .max(1)
        .optional(),
    })
    .array(),
  onlineCounts: z.tuple([text, z.object({ open: z.number(), running: z.number() })]).array(),
  peopleSortMode: z.enum(["presence", "running", "open", "name"]),
  peopleStatusFilter: z.enum(["all", "running"]),
  onlineExpanded: z.boolean(),
  ownerId: text.nullable(),
  involvingMe: z.boolean(),
  footer: user.nullable(),
  brand: z.object({
    name: text,
    agentId: optionalText,
    textAvatar: text.nullable().optional(),
    avatar: text.nullable(),
    icon: text,
    iconUrl: optionalText,
    environment: text.nullable(),
  }),
});
export type SidebarSnapshotModel = z.infer<typeof sidebarSnapshotSchema>;

export function parseSidebarSnapshot(value: unknown): SidebarSnapshotModel | null {
  const parsed = sidebarSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}

export function snapshotSessions(
  rows: readonly SidebarRecentSession[],
  presentation?: (
    row: SidebarRecentSession,
  ) => Pick<SidebarSnapshotSession, "snapshotSubtitle" | "childrenDisplayMode">,
): SidebarSnapshotSession[] {
  return rows
    .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
    .map((row) => {
      const display = presentation?.(row);
      return {
        key: row.key,
        label: row.label,
        agentId: row.agentId,
        subtitle: row.subtitle,
        icon: row.icon,
        color: row.color,
        pinned: row.pinned,
        isChild: row.isChild,
        category: row.category,
        archived: row.archived,
        boardFace: row.boardFace,
        ...display,
        // Parent attention can summarize private descendants even after their rows are omitted.
        snapshotSubtitle: containsIncognito(row.children) ? undefined : display?.snapshotSubtitle,
        children: snapshotSessions(row.children, presentation),
      };
    });
}

export function snapshotSections(
  source: SidebarVisibleSections["sections"],
  collapsedSections: ReadonlySet<string>,
  presentation?: Parameters<typeof snapshotSessions>[1],
) {
  const sections = source.flatMap((section) => {
    const rows = snapshotSessions(section.rows, presentation);
    if (section.rows.length > 0 && rows.length === 0) {
      return [];
    }
    return [
      {
        ...section,
        rows,
        ...(rows.length !== section.rows.length
          ? {
              totalRowCount: rows.length,
              visibleRowCount: Math.min(section.visibleRowCount, rows.length),
              collapsedVisibleRowCount: Math.min(section.collapsedVisibleRowCount, rows.length),
            }
          : {}),
      },
    ];
  });
  const retained = new Set<string>(sections.map((section) => section.id));
  return {
    sections,
    collapsedSections: [...collapsedSections].filter((id) => id === "online" || retained.has(id)),
  };
}

export function restoreSnapshotSession(
  row: SidebarSnapshotSession,
  selected: string,
): SidebarRecentSession {
  return {
    ...row,
    renameValue: row.label,
    active: row.key === selected,
    visuallyActive: row.key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    childSessionKeys: row.children.map((child) => child.key),
    children: row.children.map((child) => restoreSnapshotSession(child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}
