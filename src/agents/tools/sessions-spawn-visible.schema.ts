import { Type } from "typebox";
import { SessionMoveProfileTargetSchema } from "../../../packages/gateway-protocol/src/schema/session-placement.js";

export const SessionsSpawnPlacementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  SessionMoveProfileTargetSchema,
]);

export const SESSIONS_SPAWN_SESSION_SCHEMA = {
  placement: Type.Optional({
    ...SessionsSpawnPlacementSchema,
    description:
      'Execution placement: omitted or {kind: "local"} uses local execution for native and ACP runs. {kind: "profile", profileId, os?, machineClass?} selects a configured cloud profile and requires visible=true and worktree=true. Never supply placeholder selectors. Omitted cloud selectors use profile defaults; the first task starts only after cloud dispatch.',
  }),
  visible: Type.Optional(
    Type.Boolean({
      description:
        "Persistent sidebar session only when the user requests a separate session or needs to revisit and steer it independently. Internal QA/coding/review/test workers: omit or false. Subagent runtime only; default run mode and empty attachments accepted; thinking is supported with visible=true; no thread/lightContext or attachment staging.",
    }),
  ),
  group: Type.Optional(
    Type.String({
      description:
        "Custom sidebar group; requires visible=true when nonempty. A new name creates the group. Omit or pass an empty string to leave it ungrouped.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({
      description:
        "Registered project for a native subagent; hidden children require worktree=true. Mutually exclusive with projectGitUrl and cwd.",
    }),
  ),
  projectGitUrl: Type.Optional(
    Type.String({
      description:
        "GitHub HTTPS or git@github.com repository URL for a visible session's managed clone; mutually exclusive with projectId and cwd. Local paths and file URLs are not accepted.",
      maxLength: 2048,
    }),
  ),
  worktree: Type.Optional(
    Type.Boolean({
      description:
        'Managed checkout for hidden or visible runtime="subagent"; first turn waits for preparation. ACP unsupported.',
    }),
  ),
  worktreeName: Type.Optional(
    Type.String({ description: "Managed worktree name; requires worktree=true." }),
  ),
  worktreeBaseRef: Type.Optional(
    Type.String({ description: "Managed worktree base ref; requires worktree=true." }),
  ),
};
