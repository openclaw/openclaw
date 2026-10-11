import { z } from "zod";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { bootRosterSchema } from "../lib/sessions/session-boot-roster.ts";

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
  routingDefaults: z.object({ mainKey: z.string(), scope: z.enum(["per-sender", "global"]) }),
  roster: bootRosterSchema.nullable(),
  mode: z.enum(["chip", "roster"]),
  navigationView: z.enum(["pages", "sessions", "online"]),
  navigationScope: z.enum(["mine", "all"]),
  scopesEquivalent: z.boolean(),
  pages: session.array(),
  pageScopeId: z.string().nullable(),
  pinnedSessions: session.array(),
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
