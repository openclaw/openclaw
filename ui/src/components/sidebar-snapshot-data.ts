import { isSessionParticipantIdentity } from "../../../packages/gateway-protocol/src/compiled/sender-identity.js";
import { SESSION_PLACEMENT_STATES } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { SESSION_VISIBILITY_VALUES } from "../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { bootRosterSchema } from "../lib/sessions/session-boot-roster-schema.ts";
import * as json from "../lib/snapshot-json.ts";

const text = json.text;
const optionalText = json.optional(text);
const identity = json.object({ type: json.literal("profile"), id: text });
const participantIdentity = json.checked(isSessionParticipantIdentity);
const actorFields = {
  type: json.enumeration(["human", "agent", "system"]),
  id: optionalText,
  label: optionalText,
  avatarUrl: optionalText,
  identity: json.optional(participantIdentity),
};
const actor = json.object(actorFields);
const participant = json.object({
  identity: participantIdentity,
  label: optionalText,
  avatarUrl: optionalText,
});
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
  workspaceConflictCount: json.optional(json.number),
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
  // Disclosure and origin are display facts, not invented child or fork identities.
  childCount: json.optional(json.number),
  forked: json.optional(json.boolean),
});
const sessionFields = {
  key: sessionKey,
  label: text,
  agentId: optionalText,
  titlePending: json.optional(json.boolean),
  createdActor: json.optional(actor),
  owner: json.optional(json.object({ actor, assignedAt: json.optional(json.number) })),
  archivedBy: json.optional(actor),
  // Match the canonical compact (4) and expanded (32) participant wire bounds.
  participants: json.optional(json.array(participant, 4)),
  expandedParticipants: json.optional(json.array(participant, 32)),
  participantCount: json.optional(json.number),
  visibility: json.optional(json.enumeration(SESSION_VISIBILITY_VALUES)),
  draftOwnedBySelf: json.optional(json.boolean),
  subtitle: optionalText,
  channelAvatarUrl: optionalText,
  channelPresentation: json.optional(json.object({ channel: text, channelLabel: text })),
  snoozedUntil: json.optional(json.number),
  createdAt: json.optional(json.number),
  startedAt: json.optional(json.number),
  endedAt: json.optional(json.number),
  runtimeMs: json.optional(json.number),
  runtimeSampledAt: json.optional(json.number),
  hasComposerDraft: json.optional(json.boolean),
  outboxAttentionCount: json.optional(json.number),
  placementState: json.optional(json.enumeration(SESSION_PLACEMENT_STATES)),
  placementProviderId: optionalText,
  placementProfileId: optionalText,
  placementMachine: json.optional(
    json.object({
      class: optionalText,
      os: optionalText,
      osLabel: optionalText,
      cpu: json.optional(json.number),
      memoryGb: json.optional(json.number),
    }),
  ),
  diskSpaceStatus: json.optional(json.enumeration(["ok", "warning", "critical"])),
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
  grouping: json.optional(json.enumeration(["none", "category", "person", "project"])),
  navigationView: json.enumeration(["pages", "sessions", "online"]),
  pages: json.array(session),
  pageScopeId: json.nullable(text),
  pinnedSessions: json.array(session),
  personalGroups: json.optional(
    json.array(json.object({ id: text, label: text, sessionKeys: json.array(sessionKey) })),
  ),
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
          ...actorFields,
          id: text,
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
      activeNow: json.optional(json.boolean),
      assistantPreview: optionalText,
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
