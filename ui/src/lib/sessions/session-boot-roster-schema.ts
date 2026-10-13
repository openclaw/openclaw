import { z } from "zod";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.js";

const text = z.string().optional();
const actor = z.object({ type: z.enum(["human", "agent", "system"]), id: text, label: text });
// Routing and the first header need stable row facts, never live activity or permissions.
const row = z.object({
  key: z.string().refine((key) => !isIncognitoSessionKey(key)),
  kind: z.enum(["direct", "group", "global", "unknown"]),
  incognito: z.never().optional(),
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
  updatedAt: z.number().nullable().optional(),
  category: text,
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  hasBoard: z.boolean().optional(),
  boardFace: z.enum(["chat", "dashboard"]).optional(),
  boardPresentation: z.enum(["split", "expanded"]).optional(),
  workspaceDir: text,
  spawnedWorkspaceDir: text,
  spawnedCwd: text,
  execNode: text,
  execCwd: text,
  worktree: z.object({ id: z.string(), branch: z.string(), repoRoot: z.string() }).optional(),
  repository: z.object({ url: z.string(), ref: text, branch: z.string() }).optional(),
  thinkingLevel: text,
  model: text,
  modelProvider: text,
  owner: z.object({ actor }).optional(),
});
export const bootRosterSchema = z.object({
  agentId: z.string().nullable(),
  result: z.object({
    ts: z.number(),
    path: z.string(),
    count: z.number(),
    defaults: z.object({
      model: z.string().nullable(),
      modelProvider: z.string().nullable(),
      contextTokens: z.number().nullable(),
    }),
    sessions: row.array().max(SIDEBAR_SESSION_ROSTER_LIMIT),
  }),
  groups: z.string().array(),
  groupSettings: z.object({ name: z.string(), position: z.number() }).array(),
  sectionOrder: z.string().array(),
});
