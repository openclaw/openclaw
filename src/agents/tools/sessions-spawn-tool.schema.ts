import { Type } from "typebox";
import { createCachedToolSchema } from "../schema/cached-schema.js";
import { optionalStringEnum, requesterProfileSchema } from "../schema/typebox.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
} from "../subagents/spawn/subagent-spawn.types.js";
import { describeSubagentSpawnContext } from "../tool-description-presets.js";
import { SESSIONS_SPAWN_CYBER_ACCESS_PROGRAM_SCHEMA } from "./sessions-spawn-access-program.js";
import { SESSIONS_SPAWN_SESSION_SCHEMA } from "./sessions-spawn-visible.schema.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// ACP execution reaches the tools registry; schema metadata must not import that runtime.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;

export const createSessionsSpawnToolSchema = createCachedToolSchema({
  build: buildSessionsSpawnToolSchema,
  key: (params) =>
    `${params.acpAvailable}:${params.threadAvailable}:${params.subagentThreadAvailable}:${params.swarmEnabled}`,
});

function buildSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  subagentThreadAvailable: boolean;
  swarmEnabled: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    user: requesterProfileSchema({ defaultToTurnOwner: true }),
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
      { description: 'Runtime; visible=true and managed worktrees require "subagent".' },
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Child run timeout in seconds; overrides the configured subagent default and is preserved on native continuations. Zero disables the timeout; requester wake turns use their own budget.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Thinking override; unavailable with visible=true." }),
    ),
    cyberAccessProgram: SESSIONS_SPAWN_CYBER_ACCESS_PROGRAM_SCHEMA,
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory. File tools resolve relative paths against cwd. With configuration-only containment, cwd also binds their workspace root. With an explicit restricted permission mode, a hidden native child keeps its inherited recorded root; changing cwd cannot widen it. Required roots, sender restrictions, and sandbox boundaries still apply. Visible paths outside configured agent workspaces require operator.admin. Mutually exclusive with projectId/projectGitUrl. With no source selector and worktree=true: inherit the same-agent parent managed repository; otherwise use the target agent workspace.",
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
      description:
        "Hidden session cleanup; delete snapshots and removes its managed worktree through session cleanup. visible=true always keeps the session.",
    }),
    expectsCompletionMessage: Type.Optional(
      Type.Boolean({
        description:
          "false: fire-and-forget; requester gets no completion handoff when the child finishes.",
      }),
    ),
    completionTarget: optionalStringEnum(["parent"] as const, {
      description:
        "parent: return substantive results in a private requester turn; no automatic channel delivery. After sessions_yield, the parent must receive the internal result even when no external reply is needed. For external replies only, exactly NO_REPLY as the entire final answer stays silent; a literal leading NO_REPLY newline suppresses that line only. NO_REPLY discards anything written this turn that was not sent, so send confirmations before ending silently. Native hidden run only; unavailable with ACP, collect, visible, thread, session mode, or expectsCompletionMessage=false.",
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
    blind: Type.Optional(
      Type.Boolean({
        description:
          'Blind trial: child prompt omits its model, session ids and workspace path. Hidden subagent, context="isolated".',
      }),
    ),
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(
            Type.Boolean({
              description:
                "Swarm collector child for large parallel fan-out or required in-turn result collection; collect with agents_wait, no completion notification.",
            }),
          ),
          outputSchema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "JSON Schema for the child's structured result; requires collect=true.",
            }),
          ),
          fastMode: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
          ),
          groupId: Type.Optional(
            Type.String({
              description: "Groups parallel collector children; requires collect=true.",
            }),
          ),
        }
      : {}),
    ...SESSIONS_SPAWN_SESSION_SCHEMA,

    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: optionalStringEnum(["utf8", "base64"] as const),
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
