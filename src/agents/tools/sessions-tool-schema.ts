import { Type } from "typebox";
import { SessionMoveProfileTargetSchema } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { SESSIONS_PATCH_MANY_MAX_TARGETS } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import {
  SESSION_AGENT_ATTENTION_ICON_IDS,
  SESSION_COLOR_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { stringEnum } from "../schema/typebox.js";

const ACTIONS = [
  "cloud_profiles",
  "patch",
  "stop",
  "reset",
  "delete",
  "assign_owner",
  "group_list",
  "group_set",
  "group_rename",
  "group_delete",
] as const;
const SESSION_ICON_GLYPH_DESCRIPTION = SESSION_ICON_GLYPH_IDS.join(", ");

const SessionsToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: "Action" }),
    profileId: Type.Optional({
      ...SessionMoveProfileTargetSchema.properties.profileId,
      description: "cloud_profiles: return OS and machine choices for this configured profile.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "cloud_profiles: nextOffset from the previous profile-list page.",
      }),
    ),
    sessionKey: Type.Optional(Type.String({ description: "Target session. Default: current" })),
    targets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            sessionKey: Type.String({ minLength: 1 }),
            expectedSessionId: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        {
          minItems: 1,
          maxItems: SESSIONS_PATCH_MANY_MAX_TARGETS,
          description:
            "patch: apply the same settings to these sessions. Cannot combine with top-level sessionKey/expectedSessionId. Archive/restore requires each target's expectedSessionId. Current-session archive uses a single patch. Results use zero-based succeeded/failed indexes; valid targets continue after item errors.",
        },
      ),
    ),
    expectedSessionId: Type.Optional(
      Type.String({
        description:
          "Durable identity returned by sessions_list; rejects a replaced session. Required for archive, restore, or delete of another session.",
      }),
    ),
    runId: Type.Optional(
      Type.String({ description: "stop: cancel this exact active run, if specified." }),
    ),
    clearQueued: Type.Optional(
      Type.Boolean({
        description:
          "stop: also clear queued follow-ups for session-wide stop. Default true; unavailable with runId.",
      }),
    ),
    deleteTranscript: Type.Optional(
      Type.Boolean({ description: "Archive the deleted session transcript. Default: true." }),
    ),
    label: Type.Optional(
      Type.String({ description: "Sidebar title override. Empty string clears it." }),
    ),
    icon: Type.Optional(
      Type.String({
        description: `Persistent sidebar icon: a single emoji, or a named icon: ${SESSION_ICON_GLYPH_DESCRIPTION}, or custom SVG markup/data:image/svg+xml URL (max 16 KiB decoded; self-contained, no scripts or external references). Include xmlns="http://www.w3.org/2000/svg" and viewBox on SVGs. Empty string clears it. Distinct from temporary attention.`,
      }),
    ),
    color: Type.Optional(
      Type.String({
        description: `Persistent sidebar color tint, one of: ${SESSION_COLOR_IDS.join(", ")}. Empty string clears it.`,
      }),
    ),
    group: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "patch: custom sidebar group for this session. Null or an empty string clears it back to ungrouped; assigning a new name creates the group.",
      }),
    ),
    statusNote: Type.Optional(
      Type.String({
        maxLength: 120,
        description:
          "Short sidebar status line. Empty string clears it and declared attention. Clears automatically when the user reads or replies, or when its TTL expires.",
      }),
    ),
    attention: Type.Optional(
      stringEnum(["clear", ...SESSION_AGENT_ATTENTION_ICON_IDS] as const, {
        description:
          "Request user attention with a curated icon; requires an active statusNote. 'clear' clears both attention and statusNote.",
      }),
    ),
    ttlMinutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Status/attention lifetime in minutes. Default 30; maximum 120.",
      }),
    ),
    pinned: Type.Optional(
      Type.Boolean({
        description:
          "Pin session (root and Home-linked sessions only; spawned, subagent, and nested-child sessions cannot be pinned)",
      }),
    ),
    archived: Type.Optional(
      Type.Boolean({ description: "True archives without deleting; false restores the session." }),
    ),
    model: Type.Optional(Type.String({ description: "Model override" })),
    thinkingLevel: Type.Optional(Type.String({ description: "Thinking override" })),
    ownerType: Type.Optional(
      stringEnum(["human", "agent"] as const, {
        description: "New owner kind for assign_owner",
      }),
    ),
    ownerId: Type.Optional(Type.String({ description: "New owner id for assign_owner" })),
    names: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "group_set: full replacement of the ordered group catalog. Array order becomes sidebar order; new names are created; empty groups left out are deleted. Dropping a group that still has member sessions is rejected — remove it with group_delete first. Never moves sessions. To reorder, pass the complete current list in the new order.",
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "group_rename and group_delete: the group to act on." }),
    ),
    to: Type.Optional(Type.String({ description: "group_rename: the new group name." })),
  },
  { additionalProperties: false },
);

export const SessionControlToolSchema = Type.Object(
  {
    action: stringEnum(["patch", "stop"]),
    sessionKey: SessionsToolSchema.properties.sessionKey,
    expectedSessionId: SessionsToolSchema.properties.expectedSessionId,
    archived: Type.Optional(
      Type.Boolean({
        description: "patch: required; true archives without deleting, false restores.",
      }),
    ),
    runId: SessionsToolSchema.properties.runId,
    clearQueued: SessionsToolSchema.properties.clearQueued,
  },
  { additionalProperties: false },
);

/** Restrict only the newly exposed Stop action; preserve pre-existing collector controls. */
export function resolveSessionsToolSchema(controlOnly: boolean, stopAllowed: boolean) {
  const schema = controlOnly ? SessionControlToolSchema : SessionsToolSchema;
  if (stopAllowed) {
    return schema;
  }
  const { runId: _runId, clearQueued: _clearQueued, ...properties } = schema.properties;
  return Type.Object(
    {
      ...properties,
      action: stringEnum(controlOnly ? ["patch"] : ACTIONS.filter((action) => action !== "stop")),
    },
    { additionalProperties: false },
  );
}
