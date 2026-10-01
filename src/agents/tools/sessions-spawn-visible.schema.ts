import { Type } from "typebox";
import { SessionMoveProfileTargetSchema } from "../../../packages/gateway-protocol/src/schema/session-placement.js";

export const SessionsSpawnPlacementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  SessionMoveProfileTargetSchema,
]);

export const VISIBLE_SESSIONS_SPAWN_SCHEMA = {
  placement: Type.Optional({
    ...SessionsSpawnPlacementSchema,
    description:
      'Execution placement: omitted or {kind: "local"} uses local execution for native and ACP runs. {kind: "profile", profileId, os?, machineClass?} selects a configured cloud profile and requires visible=true and worktree=true. Never supply placeholder selectors. Omitted cloud selectors use profile defaults; the first task starts only after cloud dispatch.',
  }),
  visible: Type.Optional(
    Type.Boolean({
      description:
        "Persistent sidebar session only when the user requests a separate session or needs to revisit and steer it independently. Internal QA/coding/review/test workers: omit or false. Subagent runtime only; default run mode and empty attachments accepted; no thread/thinking/lightContext or attachment staging.",
    }),
  ),
  group: Type.Optional(
    Type.String({
      description:
        "Custom sidebar group for a visible session; a new name creates the group. Omit or pass an empty string to leave it ungrouped.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({
      description:
        "Registered project for a visible session; mutually exclusive with projectGitUrl and cwd.",
    }),
  ),
  projectGitUrl: Type.Optional(
    Type.String({
      description:
        "GitHub HTTPS or git@github.com repository URL for a visible session's managed clone; mutually exclusive with projectId and cwd. Local paths and file URLs are not accepted.",
      maxLength: 2048,
    }),
  ),
  worktree: Type.Optional(Type.Boolean({ description: "Visible session worktree" })),
  worktreeName: Type.Optional(Type.String({ description: "Worktree name" })),
  worktreeBaseRef: Type.Optional(Type.String({ description: "Worktree base ref" })),
};
