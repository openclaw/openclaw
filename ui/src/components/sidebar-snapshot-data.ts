import { isSessionParticipantIdentity } from "../../../packages/gateway-protocol/src/compiled/sender-identity.js";
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
const participantIdentity = json.checked(isSessionParticipantIdentity);
const actorFields = {
  type: json.enumeration(["human", "agent", "system"]),
  id: optionalText,
  label: optionalText,
  avatarUrl: optionalText,
  identity: json.optional(participantIdentity),
};
const participant = json.object({
  identity: participantIdentity,
  label: optionalText,
  avatarUrl: optionalText,
});
const viewer = json.object({ ...userFields, watchedSessions: json.array(text, 0) });
const pullRequest = json.object({
  numbers: json.array(json.number, 20),
  state: json.enumeration(["open", "draft", "merged", "closed"]),
});
const attention = json.pair(
  json.enumeration(["agent", "error", "question", "approval"]),
  json.enumeration(["hand", "key", "alertTriangle", "flag", "lock", "circle", "shieldQuestion"]),
);
export type SidebarSnapshotAttention = json.SnapshotValue<typeof attention>;
const sessionFields = {
  label: optionalText,
  agentId: optionalText,
  worktreeId: optionalText,
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
  pinned: json.optional(json.boolean),
  archived: json.optional(json.boolean),
  isChild: json.optional(json.boolean),
  category: optionalText,
  boardFace: json.optional(json.enumeration(["chat", "dashboard"])),
  incognito: json.optional(json.literal(false)),
  unread: json.optional(json.boolean),
  run: json.optional(json.enumeration(["active", "queued", "subagents"])),
  status: json.optional(
    json.enumeration(["queued", "running", "done", "failed", "interrupted", "killed", "timeout"]),
  ),
  hasAutomation: json.optional(json.boolean),
  attention: json.optional(attention),
  tone: json.optional(json.enumeration(["agent", "error", "question", "approval"])),
  slotAttention: json.optional(attention),
  slotActive: json.optional(json.number),
  slotQueued: json.optional(json.number),
  slotUnread: json.optional(json.number),
  slotFailed: json.optional(json.literal(true)),
  participants: json.optional(json.array(participant, 1)),
  participantCount: json.optional(json.number),
  owner: json.optional(json.nullable(json.object(actorFields))),
  attribution: json.optional(json.enumeration(["created", "owned", "archived"])),
  ownerViewing: json.optional(json.boolean),
  viewers: json.optional(json.array(viewer, 3)),
  viewerCount: json.optional(json.number),
  pullRequest: json.optional(pullRequest),
  pullRequestCount: json.optional(json.number),
  hasApproval: json.optional(json.literal(true)),
  children: json.array(sessionKey),
};
export type SidebarSnapshotSession = json.SnapshotObject<typeof sessionFields>;
const session = json.refine(
  json.object(sessionFields),
  (row) => row.children.length === 0 || row.childLoadParentKeys !== undefined,
);
const sectionId = json.checked(
  (value): value is SidebarSessionSection<unknown>["id"] =>
    typeof value === "string" &&
    /^(agent:|category:|person:|project:|catalog:|pinned$|ungrouped$|groups$|work$)/.test(value),
);
export const sidebarSnapshotSchema = json.object({
  rows: json.record(session),
  avatarImages: json.optional(
    json.array(
      json.object({
        url: text,
        blob: json.nullable(json.checked((value): value is Blob => value instanceof Blob)),
        retryAt: json.optional(json.number),
      }),
      128,
    ),
  ),
  avatarAgents: json.optional(
    json.array(
      json.object({
        id: text,
        name: optionalText,
        avatar: json.nullable(text),
        textAvatar: json.nullable(text),
      }),
      128,
    ),
  ),
  issues: json.optional(json.object({ visible: json.boolean, count: json.number })),
  ownerOptions: json.optional(json.array(json.object({ ...actorFields, id: text }))),
  routingDefaults: json.object({
    mainKey: text,
    scope: json.enumeration(["per-sender", "global"]),
  }),
  roster: json.nullable(bootRosterSchema),
  mode: json.enumeration(["chip", "roster"]),
  navigationView: json.enumeration(["pages", "sessions", "online"]),
  pages: json.array(sessionKey),
  pageScopeId: json.nullable(text),
  pinnedSessions: json.array(sessionKey),
  entries: json.array(
    json.refine(
      text,
      (entry) =>
        !entry.startsWith("session:") || !isIncognitoSessionKey(entry.slice("session:".length)),
    ),
  ),
  sessions: json.array(sessionKey),
  sections: json.array(
    json.object({
      id: sectionId,
      category: optionalText,
      personOwner: json.optional(json.object({ ...actorFields, id: text })),
      project: json.optional(json.object({ name: text, path: text })),
      groups: json.optional(json.boolean),
      work: json.optional(json.boolean),
      rows: json.array(sessionKey),
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
  const model = json.parseSnapshot(sidebarSnapshotSchema, value);
  if (!model) {
    return null;
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const validRow = (key: string): boolean => {
    const row = model.rows[key];
    if (!row || isIncognitoSessionKey(key) || visiting.has(key)) {
      return false;
    }
    if (visited.has(key)) {
      return true;
    }
    visiting.add(key);
    if (!row.children.every(validRow)) {
      return false;
    }
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  const keys = [
    ...Object.keys(model.rows),
    ...model.sessions,
    ...model.pages,
    ...model.pinnedSessions,
    ...model.sections.flatMap((section) => section.rows),
  ];
  return keys.every(validRow) ? model : null;
}
