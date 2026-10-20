import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.js";
import * as json from "../snapshot-json.ts";

const text = json.optional(json.text);
const actor = json.object({
  type: json.enumeration(["human", "agent", "system"]),
  id: text,
  label: text,
});
// Routing and the first header need stable row facts, never live activity or permissions.
const row = json.object({
  key: json.refine(json.text, (key) => !isIncognitoSessionKey(key)),
  kind: json.enumeration(["direct", "group", "global", "unknown"]),
  incognito: json.optional(json.never),
  sessionId: text,
  agentId: text,
  label: text,
  autoLabel: text,
  icon: text,
  color: text,
  channel: text,
  displayName: text,
  derivedTitle: text,
  lastMessagePreview: text,
  updatedAt: json.optional(json.nullable(json.number)),
  category: text,
  pinned: json.optional(json.boolean),
  archived: json.optional(json.boolean),
  hasBoard: json.optional(json.boolean),
  boardFace: json.optional(json.enumeration(["chat", "dashboard"])),
  boardPresentation: json.optional(json.enumeration(["split", "expanded"])),
  workspaceDir: text,
  spawnedWorkspaceDir: text,
  spawnedCwd: text,
  execNode: text,
  execCwd: text,
  deviceFolder: json.optional(json.object({ deviceId: json.text, path: json.text })),
  worktree: json.optional(json.object({ id: json.text, branch: json.text, repoRoot: json.text })),
  repository: json.optional(json.object({ url: json.text, ref: text, branch: json.text })),
  thinkingLevel: text,
  model: text,
  modelProvider: text,
  owner: json.optional(json.object({ actor })),
});
export const bootRosterSchema = json.object({
  agentId: json.nullable(json.text),
  result: json.object({
    ts: json.number,
    path: json.text,
    count: json.number,
    defaults: json.object({
      model: json.nullable(json.text),
      modelProvider: json.nullable(json.text),
      contextTokens: json.nullable(json.number),
    }),
    sessions: json.array(row, SIDEBAR_SESSION_ROSTER_LIMIT),
  }),
  groups: json.array(json.text),
  groupSettings: json.array(json.object({ name: json.text, position: json.number })),
  sectionOrder: json.array(json.text),
});
