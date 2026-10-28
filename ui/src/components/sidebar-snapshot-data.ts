import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { bootRosterSchema } from "../lib/sessions/session-boot-roster-schema.ts";
import * as json from "../lib/snapshot-json.ts";

const text = json.text;
const optionalText = json.optional(text);
const identity = json.object({ type: json.literal("profile"), id: text });
const userFields = {
  id: text,
  name: optionalText,
  email: optionalText,
  avatarUrl: optionalText,
  identity: json.optional(identity),
};
const user = json.object(userFields);
const sessionKey = json.refine(text, (key) => !isIncognitoSessionKey(key));
const attention = json.enumeration([
  "none",
  "error",
  "question",
  "approval",
  ...SESSION_AGENT_ATTENTION_ICON_IDS,
]);
const childrenState = {
  attention: json.optional(attention),
  runningChildCount: json.optional(json.number),
  queuedChildCount: json.optional(json.number),
  unreadChildCount: json.optional(json.number),
  failedChildCount: json.optional(json.number),
};
const state = json.object({
  unread: json.optional(json.boolean),
  isRunVisuallyActive: json.optional(json.boolean),
  hasAutomation: json.optional(json.boolean),
  status: json.optional(
    json.enumeration(["queued", "running", "done", "failed", "interrupted", "killed", "timeout"]),
  ),
  ...childrenState,
  ownAttention: json.optional(attention),
  subagentSummary: json.optional(json.object(childrenState)),
  workSession: json.optional(json.boolean),
  acpSession: json.optional(json.boolean),
  workspaceKind: json.optional(json.enumeration(["worktree", "checkout"])),
  pullRequest: json.optional(
    json.object({
      numbers: json.array(json.number, 20),
      state: json.enumeration(["open", "draft", "merged", "closed"]),
    }),
  ),
  pullRequestCount: json.optional(json.number),
  hasApproval: json.optional(json.boolean),
});
const sessionFields = {
  key: sessionKey,
  label: text,
  agentId: optionalText,
  subtitle: optionalText,
  snapshotSubtitle: json.optional(
    json.object({ subtitle: optionalText, narration: optionalText, toolName: optionalText }),
  ),
  childrenDisplayMode: json.optional(
    json.enumeration(["collapsed-by-user", "expanded", "expanded-fully"]),
  ),
  childLoadParentKeys: json.optional(json.array(sessionKey)),
  icon: optionalText,
  color: optionalText,
  pinned: json.boolean,
  archived: json.optional(json.boolean),
  isChild: json.boolean,
  category: optionalText,
  boardFace: json.optional(json.enumeration(["chat", "dashboard"])),
  incognito: json.optional(json.literal(false)),
  state: json.optional(state),
};
export type SidebarSnapshotSession = json.SnapshotObject<typeof sessionFields> & {
  children: SidebarSnapshotSession[];
};
const session: json.SnapshotReader<SidebarSnapshotSession> = json.refine(
  json.object({
    ...sessionFields,
    children: json.lazy(() => json.array(session)),
  }),
  (row) => row.children.length === 0 || row.childLoadParentKeys !== undefined,
);
const sectionId = json.checked(
  (value): value is SidebarSessionSection<unknown>["id"] =>
    typeof value === "string" &&
    /^(agent:|category:|person:|project:|catalog:|pinned$|ungrouped$|groups$|work$)/.test(value),
);
export const sidebarSnapshotSchema = json.object({
  routingDefaults: json.object({
    mainKey: text,
    scope: json.enumeration(["per-sender", "global"]),
  }),
  roster: json.nullable(bootRosterSchema),
  mode: json.enumeration(["chip", "roster"]),
  navigationView: json.enumeration(["pages", "sessions", "online"]),
  pages: json.array(session),
  pageScopeId: json.nullable(text),
  pinnedSessions: json.array(session),
  entries: json.array(
    json.refine(
      text,
      (entry) =>
        !entry.startsWith("session:") || !isIncognitoSessionKey(entry.slice("session:".length)),
    ),
  ),
  issuesCount: json.optional(json.number),
  sections: json.array(
    json.object({
      id: sectionId,
      category: optionalText,
      personOwner: json.optional(
        json.object({
          type: json.enumeration(["human", "agent", "system"]),
          id: text,
          label: optionalText,
          identity: json.optional(identity),
        }),
      ),
      project: json.optional(json.object({ name: text, path: text })),
      groups: json.optional(json.boolean),
      work: json.optional(json.boolean),
      rows: json.array(session),
      totalRowCount: json.number,
      visibleRowCount: json.number,
      visibleLimit: json.number,
      collapsedVisibleRowCount: json.number,
      renderHeader: json.boolean,
    }),
  ),
  cards: json.array(
    json.object({
      id: text,
      name: text,
      mainKey: text,
      avatar: json.optional(json.nullable(text)),
      textAvatar: json.optional(json.nullable(text)),
      role: optionalText,
      model: optionalText,
    }),
  ),
  collapsedAgentIds: json.array(text),
  collapsedSections: json.array(text),
  plugins: json.array(
    json.object({
      key: text,
      pluginId: text,
      id: text,
      label: text,
      icon: optionalText,
      placement: optionalText,
      path: optionalText,
      slug: optionalText,
    }),
  ),
  onlineUsers: json.array(
    json.object({
      ...userFields,
      watchedSessions: json.array(text, 0),
      entries: json.optional(
        json.array(json.object({ ts: json.number, lastActivityAt: json.optional(json.number) }), 1),
      ),
    }),
  ),
  onlineCounts: json.array(
    json.pair(text, json.object({ open: json.number, running: json.number })),
  ),
  peopleSortMode: json.enumeration(["presence", "running", "open", "name"]),
  peopleStatusFilter: json.enumeration(["all", "running"]),
  peoplePresenceFilter: json.defaulted(
    json.enumeration(["online", "all"]),
    (): "online" => "online",
  ),
  offlineUsers: json.defaulted(
    json.array(
      json.object({
        ...userFields,
        watchedSessions: json.array(text, 0),
        entries: json.array(json.never, 0),
      }),
    ),
    () => [],
  ),
  ownerId: json.nullable(text),
  involvingMe: json.boolean,
  footer: json.nullable(user),
  brand: json.object({
    name: text,
    agentId: optionalText,
    textAvatar: json.optional(json.nullable(text)),
    avatar: json.nullable(text),
    icon: text,
    iconUrl: optionalText,
    environment: json.nullable(text),
  }),
});
export type SidebarSnapshotModel = json.SnapshotValue<typeof sidebarSnapshotSchema>;

export function parseSidebarSnapshot(value: unknown): SidebarSnapshotModel | null {
  return json.parseSnapshot(sidebarSnapshotSchema, value);
}
