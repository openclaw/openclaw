import { Type } from "typebox";
import { SessionMoveProfileTargetSchema } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
} from "../subagents/spawn/subagent-spawn.types.js";
import { describeSubagentSpawnContext } from "../tool-description-presets.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Schema constants stay independent of ACP and native execution runtimes.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;

export const SessionsSpawnPlacementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  SessionMoveProfileTargetSchema,
]);

const VISIBLE_SESSIONS_SPAWN_SCHEMA = {
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

export function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  subagentThreadAvailable: boolean;
  swarmEnabled: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable later-target alias; starts lowercase letter; then lowercase/digit/_/-.",
      }),
    ),
    label: Type.Optional(
      Type.String({
        description: "Short task title shown in UI lists; name the work, not the agent.",
      }),
    ),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
      { description: 'Runtime; visible=true requires "subagent".' },
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Per-run timeout in seconds; overrides the configured subagent default. Zero disables the timeout.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Thinking override; unavailable with visible=true." }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory. Visible paths outside configured agent workspaces require operator.admin. Mutually exclusive with projectId/projectGitUrl. With no source selector and worktree=true: inherit the same-agent parent managed repository; otherwise use the target agent workspace.",
      }),
    ),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind to the current conversation or a new thread, as supported by the channel; true defaults mode="session"; unavailable with visible=true.',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes, {
      description: params.threadAvailable
        ? '"run" one-shot; "session" persistent/thread-bound. Visible sessions accept only omitted/default "run" and remain persistent.'
        : '"run" one-shot. Visible sessions accept omitted/default "run" and remain persistent.',
    }),
    cleanup: optionalStringEnum(["delete", "keep"] as const, {
      description: "Hidden session cleanup; visible=true always keeps the session.",
    }),
    expectsCompletionMessage: Type.Optional(
      Type.Boolean({
        description:
          "false: fire-and-forget; requester gets no completion handoff when the child finishes.",
      }),
    ),
    completionTarget: optionalStringEnum(["parent"] as const, {
      description:
        "parent: return results in a private requester turn; no automatic channel delivery. Native hidden run only; unavailable with ACP, collect, visible, thread, session mode, or expectsCompletionMessage=false.",
    }),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES, {
      description: '"inherit" parent sandbox policy; "require" fails unless child is sandboxed.',
    }),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: describeSubagentSpawnContext(params.subagentThreadAvailable),
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: "Light bootstrap; subagent only; unavailable with visible=true.",
      }),
    ),
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(
            Type.Boolean({
              description:
                "Swarm collector child for large parallel fan-out, not one or a few children; no completion notification.",
            }),
          ),
          outputSchema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "JSON Schema for the child's structured result; requires collect=true.",
            }),
          ),
          fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
          groupId: Type.Optional(
            Type.String({
              description: "Groups parallel collector children; requires collect=true.",
            }),
          ),
        }
      : {}),
    ...VISIBLE_SESSIONS_SPAWN_SCHEMA,

    // Inline attachments (snapshot-by-value).
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        {
          maxItems: 50,
          description: "Inline snapshots; visible=true accepts only an empty array.",
        },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object(
        {
          // Where the spawned agent should look for attachments.
          // Kept as a hint; implementation materializes into the child workspace.
          mountPath: Type.Optional(Type.String()),
        },
        {
          description:
            "Attachment mount hint; visible=true accepts only an omitted or blank mountPath.",
        },
      ),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description: "ACP resume id already recorded for requester; ignored by subagent.",
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description: 'ACP only; "parent" streams turn to requester. Ignored by subagent.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}
